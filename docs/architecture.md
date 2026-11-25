# System Architecture and Design

## 1. Introduction

This document describes the architecture and internal operation of the distributed key-value storage system.

The system is implemented in Node.js and consists of a central gateway and multiple independent storage nodes. Consistent hashing determines where records are stored, while an LRU cache improves read performance.

## 2. High-Level Architecture

The system has two main components.

### 2.1 Gateway

The gateway acts as the entry point for all client requests.

Its responsibilities include:

- Maintaining the consistent hash ring.
- Registering and removing storage nodes.
- Assigning keys to storage nodes.
- Forwarding HTTP requests.
- Coordinating data migration.
- Managing the LRU cache.
- Returning responses without exposing storage-node details to clients.

The gateway listens on port 3000 by default.

### 2.2 Storage Nodes

Each storage node runs as an independent Node.js HTTP server.

Its responsibilities include:

- Storing key-value records in an in-memory Map.
- Retrieving values by key.
- Updating and deleting records.
- Exposing a health-check endpoint.
- Providing internal endpoints for retrieving and clearing all records during migration.

The default configuration uses three storage nodes:

| Node   | Port |
| ------ | ---: |
| node-1 | 3001 |
| node-2 | 3002 |
| node-3 | 3003 |

## 3. Consistent Hashing

### 3.1 Hash Function

The system uses SHA-256 to calculate hash positions.

The first eight hexadecimal characters of the SHA-256 digest are converted into an integer.

Both storage-node identifiers and data keys are hashed using this function.

### 3.2 Virtual Nodes

Each physical storage node is represented by 100 virtual nodes on the hash ring.

Virtual nodes help distribute keys more evenly and reduce the impact of adding or removing a physical node.

### 3.3 Key Assignment

When a client submits a key, the gateway:

1. Calculates the key's hash position.
2. Searches the sorted hash ring.
3. Selects the first virtual node whose position is greater than or equal to the key position.
4. Wraps around to the beginning of the ring if no such position exists.
5. Routes the request to the corresponding physical storage node.

This allows the gateway to consistently determine the storage owner of a key.

## 4. Dynamic Node Membership

### 4.1 Adding a Node

When a new node joins:

1. The gateway checks that the node is reachable through its health endpoint.
2. Existing records are collected into snapshots.
3. The new node is added to the hash ring.
4. The gateway recalculates the owner of each existing key.
5. Records whose owners have changed are copied to their new destinations.
6. Original copies are deleted only after the copying phase succeeds.
7. The cache is cleared to prevent stale values.

If migration fails, the gateway restores the original ring configuration and attempts to restore original records and remove newly created copies.

### 4.2 Removing a Node

When a node leaves:

1. The gateway retrieves all records from the departing node.
2. The node is removed from the hash ring.
3. The gateway calculates the new owner of each record.
4. Records are copied to their new destinations.
5. The departing node is cleared only after all copies succeed.
6. The node is removed from the registry.
7. The cache is cleared.

If the operation fails, the gateway restores the node's original ring membership and attempts to remove destination copies.

### 4.3 Minimal Data Movement

Consistent hashing limits the number of keys that need reassignment when the cluster changes.

The implementation was tested with 1,000 keys and 100 virtual nodes per physical node.

| Operation     | Keys Reassigned | Movement |
| ------------- | --------------: | -------: |
| Add node-4    |     232 / 1,000 |   23.20% |
| Remove node-4 |     232 / 1,000 |   23.20% |

These measurements demonstrate reduced key movement compared with redistributing all records whenever the cluster membership changes.

## 5. Caching Strategy

The gateway uses a Least Recently Used (LRU) cache.

The cache has a default capacity of 100 entries.

### 5.1 Cache Read Operation

When a client requests a value:

1. The gateway checks whether the key exists in the cache.
2. If found, the value is returned immediately and its position is updated to mark it as recently used.
3. If absent, the gateway retrieves the value from the assigned storage node.
4. Successful storage responses are added to the cache.

### 5.2 Cache Write and Delete Operations

- Successful writes update the cached value.
- Successful deletes remove the corresponding cache entry.
- Node membership changes clear the cache to avoid stale values.

### 5.3 Cache Statistics

The cache tracks:

- Hits
- Misses
- Current size
- Maximum capacity
- Hit rate

A cold-cache test produced one miss followed by one hit, demonstrating that repeated reads can be served from memory.

## 6. HTTP Communication

The gateway and storage nodes communicate through HTTP requests.

### 6.1 Client-to-Gateway Communication

Clients use the gateway API:

| Method | Endpoint             | Purpose                  |
| ------ | -------------------- | ------------------------ |
| GET    | `/api/data?key=KEY`  | Retrieve a value         |
| PUT    | `/api/data?key=KEY`  | Store or update a value  |
| DELETE | `/api/data?key=KEY`  | Delete a value           |
| GET    | `/api/nodes`         | List registered nodes    |
| POST   | `/api/nodes`         | Add a node               |
| DELETE | `/api/nodes/:nodeId` | Remove a node            |
| GET    | `/api/cache/stats`   | Inspect cache statistics |

### 6.2 Gateway-to-Storage Communication

Storage nodes expose the following internal endpoints:

| Method | Endpoint        | Purpose              |
| ------ | --------------- | -------------------- |
| GET    | `/health`       | Check node health    |
| GET    | `/data?key=KEY` | Retrieve a record    |
| PUT    | `/data?key=KEY` | Store a record       |
| DELETE | `/data?key=KEY` | Delete a record      |
| GET    | `/data/all`     | Retrieve all records |
| DELETE | `/data/all`     | Clear all records    |

## 7. Client Transparency

The gateway hides the internal storage topology from clients.

A client does not need to know:

- How many storage nodes are running.
- Which node owns a particular key.
- Where records are physically stored.
- How records are migrated when nodes join or leave.

Clients submit requests to a single gateway endpoint, and the gateway handles routing internally.

This demonstrates location transparency at the application level.

## 8. Failure Simulation and Availability

The system simulates a storage-node failure by stopping an individual storage-node process.

During testing, node-3 was stopped.

The following results were observed:

| Request                                 | Result   |
| --------------------------------------- | -------- |
| Retrieve `user:101`, assigned to node-3 | HTTP 503 |
| Retrieve `user:102`, assigned to node-1 | HTTP 200 |

The gateway continued serving requests assigned to healthy nodes.

Previously cached records could also remain accessible even if their original storage node became unavailable.

This is limited availability, not complete fault tolerance.

The system does not currently implement replication or automatic failover. A record stored only on an unavailable node cannot be retrieved from storage until that node is restored or the data is recovered.

## 9. Storage and Recovery Limitations

Storage nodes currently use an in-memory JavaScript Map.

Consequently:

- Records are not persisted to disk.
- Restarting a storage node clears its stored records.
- There are no replica copies on other nodes.
- Recovery after a process failure requires restoring the records.
- The gateway cache is also in memory and is cleared when the gateway restarts.

These limitations are intentional simplifications for this educational simulation.

## 10. Testing Strategy

The project uses Node.js's built-in test runner.

The test suite covers:

- Hash-ring assignment and deterministic routing.
- Adding and removing nodes.
- Duplicate-node prevention.
- Minimal key movement.
- LRU cache retrieval and eviction.
- Cache hit and miss statistics.
- Storage-node HTTP operations.
- Gateway integration.
- Data migration.
- Failure behavior and limited availability.

The final test suite completed successfully with 15 passing tests and zero failures.

## 11. Conclusion

The architecture demonstrates how a distributed key-value storage system can use consistent hashing to distribute records, dynamic membership to adapt to cluster changes, caching to improve read performance, and a gateway to hide internal storage complexity.

The failure simulation also demonstrates the distinction between limited availability and full fault tolerance, highlighting the importance of replication and persistent storage in production distributed systems.

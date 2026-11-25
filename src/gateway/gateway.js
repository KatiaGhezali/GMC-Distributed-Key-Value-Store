import http from "node:http";
import { HashRing } from "./hashRing.js";
import { LRUCache } from "./cache.js";

const PORT = Number(process.env.GATEWAY_PORT || 3000);

const ring = new HashRing(100);
const cache = new LRUCache(100);
const nodes = new Map();

function registerInitialNodes() {
  const configuredNodes =
    process.env.STORAGE_NODES ||
    "node-1=http://localhost:3001,node-2=http://localhost:3002,node-3=http://localhost:3003";

  for (const entry of configuredNodes.split(",")) {
    const [nodeId, url] = entry.split("=");

    if (!nodeId || !url) {
      throw new Error(`Invalid storage node configuration: ${entry}`);
    }

    nodes.set(nodeId, url);
    ring.addNode(nodeId);
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
  });

  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 1024 * 1024) {
      throw new Error("Request body too large");
    }
  }

  return JSON.parse(body);
}

async function forwardToNode(nodeId, path, options = {}) {
  const nodeUrl = nodes.get(nodeId);

  if (!nodeUrl) {
    throw new Error(`Storage node ${nodeId} is not registered`);
  }

  const response = await fetch(`${nodeUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(3000),
  });

  const data = await response.json();

  return {
    status: response.status,
    data,
  };
}

// Retrieve every record from a storage node.
async function getAllRecords(nodeId) {
  const result = await forwardToNode(nodeId, "/data/all");

  if (result.status !== 200) {
    throw new Error(`Could not retrieve records from ${nodeId}`);
  }

  return result.data;
}

// Store a record on its new owner.
async function storeOnNode(nodeId, key, value) {
  const result = await forwardToNode(
    nodeId,
    `/data?key=${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    },
  );

  if (result.status !== 200) {
    throw new Error(`Could not migrate key ${key} to ${nodeId}`);
  }
}

// Delete a record from a storage node.
async function deleteFromNode(nodeId, key) {
  const result = await forwardToNode(
    nodeId,
    `/data?key=${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );

  if (result.status !== 200 && result.status !== 404) {
    throw new Error(`Could not delete key ${key} from ${nodeId}`);
  }
}

// Add a node dynamically.

async function addNode(nodeId, nodeUrl) {
  if (nodes.has(nodeId)) {
    throw new Error(`Node ${nodeId} already exists`);
  }

  const health = await fetch(`${nodeUrl}/health`, {
    signal: AbortSignal.timeout(3000),
  });

  if (!health.ok) {
    throw new Error(`Node ${nodeId} is not healthy`);
  }

  // Snapshot records before changing the hash ring.
  const snapshots = new Map();

  for (const sourceNodeId of nodes.keys()) {
    snapshots.set(sourceNodeId, await getAllRecords(sourceNodeId));
  }

  const migrationLog = [];
  const copiedRecords = [];

  nodes.set(nodeId, nodeUrl);
  ring.addNode(nodeId);

  try {
    // First copy records to their new owners.
    // Original records remain untouched during this phase.
    for (const [sourceNodeId, records] of snapshots) {
      for (const [key, value] of Object.entries(records)) {
        const destinationNodeId = ring.getNode(key);

        if (destinationNodeId !== sourceNodeId) {
          await storeOnNode(destinationNodeId, key, value);

          copiedRecords.push({
            key,
            value,
            from: sourceNodeId,
            to: destinationNodeId,
          });

          migrationLog.push({
            key,
            from: sourceNodeId,
            to: destinationNodeId,
          });
        }
      }
    }

    // Delete original records after all copies succeed
    for (const record of copiedRecords) {
      await deleteFromNode(record.from, record.key);
    }

    cache.clear();

    return {
      message: `Node ${nodeId} added successfully`,
      migratedKeys: migrationLog.length,
      migrationLog,
    };
  } catch (error) {
    // Restore the original hash-ring configuration.
    ring.removeNode(nodeId);
    nodes.delete(nodeId);

    // Restore original records in case deletion had already started.
    for (const record of copiedRecords) {
      try {
        await storeOnNode(record.from, record.key, record.value);
      } catch (restoreError) {
        console.error(
          `[MIGRATION ROLLBACK] Could not restore ${record.key}:`,
          restoreError.message,
        );
      }
    }

    // Remove copies created during the failed migration.
    for (const record of copiedRecords) {
      try {
        await deleteFromNode(record.to, record.key);
      } catch (cleanupError) {
        console.error(
          `[MIGRATION ROLLBACK] Could not clean ${record.key}:`,
          cleanupError.message,
        );
      }
    }

    throw error;
  }
}

// Remove a node dynamically and migrate its records.

async function removeNode(nodeId) {
  if (!nodes.has(nodeId)) {
    throw new Error(`Node ${nodeId} does not exist`);
  }

  if (nodes.size <= 1) {
    throw new Error("Cannot remove the last storage node");
  }

  // Keep the original records until migration succeeds.
  const records = await getAllRecords(nodeId);
  const migrationLog = [];

  ring.removeNode(nodeId);

  try {
    // Copy records to their new owners.
    for (const [key, value] of Object.entries(records)) {
      const destinationNodeId = ring.getNode(key);

      await storeOnNode(destinationNodeId, key, value);

      migrationLog.push({
        key,
        from: nodeId,
        to: destinationNodeId,
        value,
      });
    }

    // Clear the departing node only after all copies succeed.
    const clearResult = await forwardToNode(nodeId, "/data/all", {
      method: "DELETE",
    });

    if (clearResult.status !== 200) {
      throw new Error(`Could not clear data from ${nodeId}`);
    }

    nodes.delete(nodeId);
    cache.clear();

    return {
      message: `Node ${nodeId} removed successfully`,
      migratedKeys: migrationLog.length,
      migrationLog: migrationLog.map(({ value, ...entry }) => entry),
    };
  } catch (error) {
    // Restore the original ring.
    ring.addNode(nodeId);

    // Remove destination copies because the original node remains active.
    for (const record of migrationLog) {
      try {
        await deleteFromNode(record.to, record.key);
      } catch (cleanupError) {
        console.error(
          `[REMOVAL ROLLBACK] Could not clean ${record.key}:`,
          cleanupError.message,
        );
      }
    }

    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        status: "healthy",
        service: "distributed-key-value-gateway",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/nodes") {
      sendJson(res, 200, {
        nodes: ring.getNodes(),
        count: ring.getNodes().length,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/nodes") {
      const body = await readBody(req);

      if (!body.nodeId || !body.url) {
        sendJson(res, 400, {
          error: "nodeId and url are required",
        });
        return;
      }

      const result = await addNode(body.nodeId, body.url);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/nodes/")) {
      const nodeId = decodeURIComponent(url.pathname.split("/").pop());

      const result = await removeNode(nodeId);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cache/stats") {
      sendJson(res, 200, cache.getStats());
      return;
    }

    if (url.pathname !== "/api/data") {
      sendJson(res, 404, { error: "Route not found" });
      return;
    }

    const key = url.searchParams.get("key");

    if (!key) {
      sendJson(res, 400, { error: "A key is required" });
      return;
    }

    const nodeId = ring.getNode(key);
    const encodedKey = encodeURIComponent(key);

    if (req.method === "GET") {
      const cachedValue = cache.get(key);

      if (cachedValue !== undefined) {
        sendJson(res, 200, {
          key,
          value: cachedValue,
          source: "cache",
        });
        return;
      }

      const result = await forwardToNode(nodeId, `/data?key=${encodedKey}`);

      if (result.status === 200) {
        cache.set(key, result.data.value);

        sendJson(res, 200, {
          ...result.data,
          source: "storage",
          nodeId,
        });
        return;
      }

      sendJson(res, result.status, result.data);
      return;
    }

    if (req.method === "PUT") {
      const body = await readBody(req);

      if (!Object.hasOwn(body, "value")) {
        sendJson(res, 400, { error: "A value is required" });
        return;
      }

      const result = await forwardToNode(nodeId, `/data?key=${encodedKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (result.status === 200) {
        cache.set(key, body.value);
      }

      sendJson(res, result.status, {
        ...result.data,
        nodeId,
      });
      return;
    }

    if (req.method === "DELETE") {
      const result = await forwardToNode(nodeId, `/data?key=${encodedKey}`, {
        method: "DELETE",
      });

      if (result.status === 200) {
        cache.delete(key);
      }

      sendJson(res, result.status, result.data);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error("[GATEWAY ERROR]", error.message);

    sendJson(res, 503, {
      error: error.message,
    });
  }
});

registerInitialNodes();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Gateway listening on port ${PORT}`);
  console.log(`Registered storage nodes: ${ring.getNodes().join(", ")}`);
});

import test from "node:test";
import assert from "node:assert/strict";
import { StorageNode } from "../src/node/storageNode.js";

test("storage node handles HTTP operations", async () => {
  const node = new StorageNode("test-node", 0);

  await node.start();

  const port = node.server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // Health check
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const healthData = await health.json();
    assert.equal(healthData.nodeId, "test-node");

    // Store a value
    const put = await fetch(`${baseUrl}/data?key=user:101`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: { name: "Alice" },
      }),
    });

    assert.equal(put.status, 200);

    // Retrieve the value
    const get = await fetch(`${baseUrl}/data?key=user:101`);
    assert.equal(get.status, 200);

    const result = await get.json();
    assert.deepEqual(result.value, { name: "Alice" });

    // Verify a missing key
    const missing = await fetch(`${baseUrl}/data?key=user:999`);
    assert.equal(missing.status, 404);

    // Delete the value
    const deleted = await fetch(`${baseUrl}/data?key=user:101`, {
      method: "DELETE",
    });

    assert.equal(deleted.status, 200);

    // Confirm it was deleted
    const afterDelete = await fetch(`${baseUrl}/data?key=user:101`);

    assert.equal(afterDelete.status, 404);

    // Store records for migration.
    await fetch(`${baseUrl}/data?key=user:101`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: { name: "Alice" },
      }),
    });

    await fetch(`${baseUrl}/data?key=user:102`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: { name: "Bob" },
      }),
    });

    // Retrieve all records.
    const allData = await fetch(`${baseUrl}/data/all`);
    assert.equal(allData.status, 200);

    const records = await allData.json();

    assert.deepEqual(records, {
      "user:101": { name: "Alice" },
      "user:102": { name: "Bob" },
    });

    // Clear records after migration.
    const clearData = await fetch(`${baseUrl}/data/all`, {
      method: "DELETE",
    });

    assert.equal(clearData.status, 200);

    const clearResult = await clearData.json();
    assert.equal(clearResult.deletedCount, 2);

    // Confirm the node is empty.
    const emptyData = await fetch(`${baseUrl}/data/all`);
    assert.deepEqual(await emptyData.json(), {});
  } finally {
    await node.stop();
  }
});

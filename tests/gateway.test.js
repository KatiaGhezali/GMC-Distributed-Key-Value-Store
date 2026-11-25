import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { HashRing } from "../src/gateway/hashRing.js";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function startProcess(script, env) {
  return spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
}

async function waitForHealth(url, processRef) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (processRef.exitCode !== null) {
      throw new Error("Service exited before becoming healthy");
    }

    try {
      const response = await fetch(`${url}/health`);

      if (response.ok) return;
    } catch {
      // Service may still be starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Service did not become healthy: ${url}`);
}

async function stopProcess(processRef) {
  if (processRef.exitCode !== null) return;

  processRef.kill("SIGTERM");

  await new Promise((resolve) => {
    processRef.once("exit", resolve);
    setTimeout(() => {
      if (processRef.exitCode === null) {
        processRef.kill("SIGKILL");
      }
      resolve();
    }, 2000);
  });
}

test("gateway distributes data, migrates records and handles failures", async () => {
  const nodePorts = await Promise.all([
    getFreePort(),
    getFreePort(),
    getFreePort(),
  ]);

  const gatewayPort = await getFreePort();

  const nodeConfigs = nodePorts.map((port, index) => ({
    id: `node-${index + 1}`,
    url: `http://127.0.0.1:${port}`,
    port,
  }));

  const processes = [];

  let gatewayProcess;
  let fourthNodeProcess;

  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    // Start three storage nodes.
    for (const node of nodeConfigs) {
      const processRef = startProcess("./src/node/server.js", {
        NODE_ID: node.id,
        NODE_PORT: String(node.port),
      });

      processes.push(processRef);
      await waitForHealth(node.url, processRef);
    }

    // Start the gateway.
    const configuredNodes = nodeConfigs
      .map((node) => `${node.id}=${node.url}`)
      .join(",");

    gatewayProcess = startProcess("./src/gateway/gateway.js", {
      GATEWAY_PORT: String(gatewayPort),
      STORAGE_NODES: configuredNodes,
    });

    await waitForHealth(gatewayUrl, gatewayProcess);

    // Store a record through the gateway.
    const put = await fetch(`${gatewayUrl}/api/data?key=user:101`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: { name: "Alice" },
      }),
    });

    assert.equal(put.status, 200);

    // Retrieve the record.
    const firstGet = await fetch(`${gatewayUrl}/api/data?key=user:101`);

    assert.equal(firstGet.status, 200);

    const firstData = await firstGet.json();
    assert.deepEqual(firstData.value, { name: "Alice" });
    assert.equal(firstData.source, "cache");

    // Add a fourth storage node.
    const fourthNodePort = await getFreePort();
    const fourthNodeUrl = `http://127.0.0.1:${fourthNodePort}`;

    fourthNodeProcess = startProcess("./src/node/server.js", {
      NODE_ID: "node-4",
      NODE_PORT: String(fourthNodePort),
    });

    await waitForHealth(fourthNodeUrl, fourthNodeProcess);

    const addNode = await fetch(`${gatewayUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: "node-4",
        url: fourthNodeUrl,
      }),
    });

    assert.equal(addNode.status, 200);

    const addResult = await addNode.json();
    assert.equal(addResult.message, "Node node-4 added successfully");

    // Verify the original record remains accessible.
    const afterJoin = await fetch(`${gatewayUrl}/api/data?key=user:101`);

    assert.equal(afterJoin.status, 200);
    assert.deepEqual((await afterJoin.json()).value, { name: "Alice" });

    // Remove the fourth node.
    const removeNode = await fetch(`${gatewayUrl}/api/nodes/node-4`, {
      method: "DELETE",
    });

    assert.equal(removeNode.status, 200);

    // Verify the record is still available.
    const afterRemoval = await fetch(`${gatewayUrl}/api/data?key=user:101`);

    assert.equal(afterRemoval.status, 200);
    assert.deepEqual((await afterRemoval.json()).value, { name: "Alice" });

    // Find a key assigned to node-1.
    const ring = new HashRing(100);

    for (const node of nodeConfigs) {
      ring.addNode(node.id);
    }

    const failedNodeKey = Array.from(
      { length: 10000 },
      (_, index) => `failure-test:${index}`,
    ).find((key) => ring.getNode(key) === "node-1");

    assert.ok(failedNodeKey);

    // Stop node-1 to simulate a failure.
    await stopProcess(processes[0]);

    // A request assigned to the failed node should return 503.
    const failedRequest = await fetch(
      `${gatewayUrl}/api/data?key=${encodeURIComponent(failedNodeKey)}`,
    );

    assert.equal(failedRequest.status, 503);

    // A request assigned to a healthy node should still be handled.
    const healthyKey = Array.from(
      { length: 10000 },
      (_, index) => `healthy-test:${index}`,
    ).find((key) => ring.getNode(key) === "node-2");

    assert.ok(healthyKey);

    const healthyRequest = await fetch(
      `${gatewayUrl}/api/data?key=${encodeURIComponent(healthyKey)}`,
    );

    assert.equal(healthyRequest.status, 404);

    console.log("Gateway integration test completed successfully.");
  } finally {
    if (gatewayProcess) await stopProcess(gatewayProcess);

    if (fourthNodeProcess) {
      await stopProcess(fourthNodeProcess);
    }

    for (const processRef of processes) {
      await stopProcess(processRef);
    }
  }
});

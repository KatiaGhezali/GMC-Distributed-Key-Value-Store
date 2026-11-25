import { StorageNode } from "./storageNode.js";

const nodeId = process.env.NODE_ID || "node-1";
const port = Number(process.env.NODE_PORT || 3001);

const node = new StorageNode(nodeId, port);

try {
  await node.start();
} catch (error) {
  console.error(`[${nodeId}] Failed to start:`, error);
  process.exit(1);
}

async function shutdown() {
  console.log(`[${nodeId}] Shutting down...`);
  await node.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

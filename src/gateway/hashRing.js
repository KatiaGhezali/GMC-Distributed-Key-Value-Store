import { createHash } from "node:crypto";

export class HashRing {
  constructor(virtualNodes = 100) {
    this.virtualNodes = virtualNodes;
    this.ring = [];
    this.nodes = new Set();
  }

  hash(value) {
    const digest = createHash("sha256").update(String(value)).digest("hex");

    return parseInt(digest.slice(0, 8), 16);
  }

  addNode(nodeId) {
    if (this.nodes.has(nodeId)) {
      return false;
    }

    this.nodes.add(nodeId);

    for (let i = 0; i < this.virtualNodes; i++) {
      const position = this.hash(`${nodeId}#${i}`);

      this.ring.push({
        position,
        nodeId,
      });
    }

    this.ring.sort((a, b) => a.position - b.position);

    return true;
  }

  removeNode(nodeId) {
    if (!this.nodes.has(nodeId)) {
      return false;
    }

    this.nodes.delete(nodeId);
    this.ring = this.ring.filter((entry) => entry.nodeId !== nodeId);

    return true;
  }

  getNode(key) {
    if (this.ring.length === 0) {
      throw new Error("No storage nodes are available.");
    }

    const keyPosition = this.hash(key);

    let left = 0;
    let right = this.ring.length - 1;

    while (left <= right) {
      const middle = Math.floor((left + right) / 2);

      if (this.ring[middle].position < keyPosition) {
        left = middle + 1;
      } else {
        right = middle - 1;
      }
    }

    // Wrap around to the first node if necessary.
    const index = left % this.ring.length;

    return this.ring[index].nodeId;
  }

  getNodes() {
    return [...this.nodes];
  }
}

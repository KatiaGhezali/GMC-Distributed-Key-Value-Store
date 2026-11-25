import test from "node:test";
import assert from "node:assert/strict";
import { HashRing } from "../src/gateway/hashRing.js";

test("assigns a key to a storage node", () => {
  const ring = new HashRing();

  ring.addNode("node-1");
  ring.addNode("node-2");
  ring.addNode("node-3");

  const node = ring.getNode("user:101");

  assert.ok(ring.getNodes().includes(node));
});

test("returns the same node for the same key", () => {
  const ring = new HashRing();

  ring.addNode("node-1");
  ring.addNode("node-2");
  ring.addNode("node-3");

  assert.equal(ring.getNode("user:101"), ring.getNode("user:101"));
});

test("adds and removes nodes", () => {
  const ring = new HashRing();

  assert.equal(ring.addNode("node-1"), true);
  assert.equal(ring.addNode("node-2"), true);

  assert.deepEqual(ring.getNodes(), ["node-1", "node-2"]);

  assert.equal(ring.removeNode("node-1"), true);
  assert.deepEqual(ring.getNodes(), ["node-2"]);
});

test("does not add duplicate nodes", () => {
  const ring = new HashRing();

  ring.addNode("node-1");

  assert.equal(ring.addNode("node-1"), false);
  assert.equal(ring.getNodes().length, 1);
});

test("throws an error when no nodes are available", () => {
  const ring = new HashRing();

  assert.throws(
    () => ring.getNode("user:101"),
    /No storage nodes are available/,
  );
});

test("minimizes key movement when a node joins", () => {
  const ring = new HashRing(100);

  ring.addNode("node-1");
  ring.addNode("node-2");
  ring.addNode("node-3");

  const keys = Array.from({ length: 1000 }, (_, index) => `user:${index + 1}`);

  const previousAssignments = new Map(
    keys.map((key) => [key, ring.getNode(key)]),
  );

  ring.addNode("node-4");

  let movedKeys = 0;

  for (const key of keys) {
    if (previousAssignments.get(key) !== ring.getNode(key)) {
      movedKeys++;
    }
  }

  const movementPercentage = (movedKeys / keys.length) * 100;

  console.log(
    `Key movement after adding node-4: ${movedKeys}/1000 (${movementPercentage.toFixed(2)}%)`,
  );

  assert.ok(
    movementPercentage < 50,
    "Adding one node should move fewer than half of the keys",
  );
});

test("minimizes key movement when a node leaves", () => {
  const ring = new HashRing(100);

  ring.addNode("node-1");
  ring.addNode("node-2");
  ring.addNode("node-3");
  ring.addNode("node-4");

  const keys = Array.from({ length: 1000 }, (_, index) => `user:${index + 1}`);

  const previousAssignments = new Map(
    keys.map((key) => [key, ring.getNode(key)]),
  );

  ring.removeNode("node-4");

  let movedKeys = 0;

  for (const key of keys) {
    if (previousAssignments.get(key) !== ring.getNode(key)) {
      movedKeys++;
    }
  }

  const movementPercentage = (movedKeys / keys.length) * 100;

  console.log(
    `Key movement after removing node-4: ${movedKeys}/1000 (${movementPercentage.toFixed(2)}%)`,
  );

  assert.ok(
    movementPercentage < 50,
    "Removing one node should move fewer than half of the keys",
  );
});

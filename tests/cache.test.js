import test from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "../src/gateway/cache.js";

test("stores and retrieves values", () => {
  const cache = new LRUCache(3);

  cache.set("user:101", { name: "Alice" });

  assert.deepEqual(cache.get("user:101"), { name: "Alice" });
});

test("returns undefined for a missing key", () => {
  const cache = new LRUCache(3);

  assert.equal(cache.get("user:999"), undefined);
});

test("evicts the least recently used item", () => {
  const cache = new LRUCache(2);

  cache.set("user:101", { name: "Alice" });
  cache.set("user:102", { name: "Bob" });

  // Access Alice, making Bob the least recently used.
  cache.get("user:101");

  cache.set("user:103", { name: "Charlie" });

  assert.deepEqual(cache.get("user:101"), { name: "Alice" });
  assert.equal(cache.get("user:102"), undefined);
  assert.deepEqual(cache.get("user:103"), { name: "Charlie" });
});

test("updates an existing key without increasing cache size", () => {
  const cache = new LRUCache(2);

  cache.set("user:101", { name: "Alice" });
  cache.set("user:101", { name: "Alice Updated" });

  assert.deepEqual(cache.get("user:101"), { name: "Alice Updated" });
  assert.equal(cache.getStats().size, 1);
});

test("tracks cache hits and misses", () => {
  const cache = new LRUCache(2);

  cache.set("user:101", { name: "Alice" });

  cache.get("user:101");
  cache.get("user:999");

  const stats = cache.getStats();

  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 0.5);
});

test("rejects invalid cache capacity", () => {
  assert.throws(() => new LRUCache(0), /positive integer/);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { createThumbnailLoader } = require("../../.unit-test-dist/viewer/thumbnail-loader.js");

test("thumbnail loader bounds concurrent work, deduplicates requests, and drops stale queued work", async () => {
  const resolvers = [];
  const calls = [];
  const loader = createThumbnailLoader({
    maxConcurrent: 1,
    load: (path) => {
      calls.push(path);
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  const first = loader.load("first.png", 160);
  const duplicate = loader.load("first.png", 160);
  const stale = loader.load("stale.png", 160);
  loader.retain(new Set([loader.keyFor("first.png", 160)]));

  assert.deepEqual(calls, ["first.png"]);
  assert.equal(await stale, undefined);
  resolvers.shift()("data:first");
  assert.equal(await first, "data:first");
  assert.equal(await duplicate, "data:first");
  assert.deepEqual(calls, ["first.png"]);
  assert.equal(await loader.load("first.png", 160), "data:first");
});

test("clearing thumbnails invalidates active and queued results without refilling stale cache", async () => {
  const pending = [], calls = [];
  const loader = createThumbnailLoader({maxConcurrent: 1, load: path => {
    calls.push(path); return new Promise(resolve => pending.push(resolve));
  }});
  const old = loader.load("same.png", 64), queued = loader.load("queued.png", 64);
  loader.clear();
  assert.equal(await old, undefined); assert.equal(await queued, undefined);
  const current = loader.load("same.png", 64);
  pending.shift()("old");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["same.png", "same.png"]);
  pending.shift()("new"); assert.equal(await current, "new");
  assert.equal(await loader.load("same.png", 64), "new");
});

test("thumbnail memory budget evicts old data URLs even below the entry limit", async () => {
  let calls=0;
  const loader=createThumbnailLoader({maxCacheBytes:8,load:async()=>{calls++;return "1234";}});
  await loader.load("a",64);await loader.load("b",64);await loader.load("a",64);
  assert.equal(calls,3);
});

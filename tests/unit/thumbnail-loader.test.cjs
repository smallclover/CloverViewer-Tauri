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

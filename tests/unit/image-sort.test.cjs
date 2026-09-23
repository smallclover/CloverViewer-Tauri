const assert = require("node:assert/strict");
const test = require("node:test");
const { sortImagesByModified } = require("../../.unit-test-dist/viewer/image-sort.js");

const images = [
  { path: "d.png", modified: "2026-04-02T00:00:00Z" },
  { path: "b.png", modified: "2026-09-01T00:00:00Z" },
  { path: "a.png", modified: "2026-04-01T00:00:00Z" },
  { path: "c.png", modified: "2026-04-02T00:00:00Z" },
];

test("modification-time sorting keeps each date group contiguous", () => {
  const sorted = sortImagesByModified(images, true);

  assert.deepEqual(
    sorted.map((image) => image.path),
    ["b.png", "c.png", "d.png", "a.png"],
  );
  assert.deepEqual(
    images.map((image) => image.path),
    ["d.png", "b.png", "a.png", "c.png"],
  );
});

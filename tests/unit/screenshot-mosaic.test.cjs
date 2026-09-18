const assert = require("node:assert/strict");
const test = require("node:test");
const { forEachMosaicStamp } = require("../../.unit-test-dist/screenshot/mosaic.js");

test("mosaic stamping preserves short paths without interpolation", () => {
  const stamps = [];
  forEachMosaicStamp([{ x: 1, y: 2 }, { x: 4, y: 2 }], 4, (point) => stamps.push(point));

  assert.deepEqual(stamps, [{ x: 1, y: 2 }, { x: 4, y: 2 }]);
});

test("mosaic stamping fills gaps larger than one block", () => {
  const stamps = [];
  forEachMosaicStamp([{ x: 0, y: 0 }, { x: 10, y: 0 }], 4, (point) => stamps.push(point));

  assert.equal(stamps.length, 4);
  assert.deepEqual(stamps.slice(0, 2), [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  assert.ok(Math.abs(stamps[2].x - 10 / 3) < 1e-12);
  assert.ok(Math.abs(stamps[3].x - 20 / 3) < 1e-12);
});

test("mosaic stamping skips an invalid block size", () => {
  const stamps = [];
  forEachMosaicStamp([{ x: 0, y: 0 }], 0, (point) => stamps.push(point));
  assert.deepEqual(stamps, []);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { centerColorHex } = require("../../.unit-test-dist/screenshot/magnifier.js");

test("magnifier copies the center pixel as an uppercase hex color", () => {
  const pixels = new Uint8ClampedArray(3 * 3 * 4);
  const center = (1 * 3 + 1) * 4;
  pixels.set([10, 171, 255, 128], center);

  assert.equal(centerColorHex(pixels, 3), "#0AABFF");
});

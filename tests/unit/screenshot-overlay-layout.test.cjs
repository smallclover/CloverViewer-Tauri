const assert = require("node:assert/strict");
const test = require("node:test");
const { overlaps, placeScrollOverlay, placeSelectionOverlay } = require("../../.unit-test-dist/screenshot/overlay-layout.js");

const viewport = { x: 0, y: 0, w: 500, h: 400 };

test("selection overlays align to the selection and flip above the bottom edge", () => {
  assert.deepEqual(placeSelectionOverlay({ x: 100, y: 100, w: 200, h: 100 }, viewport, { w: 100, h: 44 }, "end"), {
    x: 200,
    y: 210,
  });
  assert.deepEqual(placeSelectionOverlay({ x: 450, y: 350, w: 40, h: 30 }, viewport, { w: 360, h: 44 }, "end"), {
    x: 130,
    y: 296,
  });
});

test("scroll HUD chooses an outside candidate within the current monitor", () => {
  const region = { x: 100, y: 100, w: 200, h: 200 };
  const point = placeScrollOverlay(region, { x: 0, y: 0, w: 800, h: 600 }, { w: 280, h: 100 }, "hud");

  assert.deepEqual(point, { x: 310, y: 100 });
  assert.equal(overlaps({ ...point, w: 280, h: 100 }, region), false);
});

test("scroll panel remains clamped to a small monitor when every candidate is constrained", () => {
  const point = placeScrollOverlay({ x: 0, y: 0, w: 300, h: 180 }, { x: 0, y: 0, w: 300, h: 200 }, { w: 280, h: 100 }, "panel");

  assert.ok(point.x >= 10 && point.x <= 10);
  assert.ok(point.y >= 10 && point.y <= 90);
});

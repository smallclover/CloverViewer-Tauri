const assert = require("node:assert/strict");
const test = require("node:test");
const { cloneShape, isShapeHit, normRect, shapeBBox, shapeHandles } = require("../../.unit-test-dist/screenshot/geometry.js");

const baseShape = {
  tool: "rect",
  start: { x: 30, y: 40 },
  end: { x: 10, y: 20 },
  color: "#cc0000",
  strokeWidth: 2,
};

test("annotation geometry normalizes rectangles and derives stroke handles", () => {
  assert.deepEqual(normRect(baseShape.start, baseShape.end), { x: 10, y: 20, w: 20, h: 20 });
  assert.equal(shapeHandles(baseShape).length, 8);
  assert.deepEqual(shapeHandles({ ...baseShape, tool: "arrow" }), [baseShape.start, baseShape.end]);
});

test("freehand annotations use their points for bounds and hit testing", () => {
  const pen = { ...baseShape, tool: "pen", points: [{ x: 5, y: 12 }, { x: 15, y: 3 }, { x: 25, y: 8 }] };

  assert.deepEqual(shapeBBox(pen), { x: 5, y: 3, w: 20, h: 9 });
  assert.equal(isShapeHit(pen, { x: 15, y: 3 }, 1), true);
  assert.equal(isShapeHit(pen, { x: 15, y: 20 }, 1), false);
});

test("ellipse and arrow hit tests respect the stroke rather than their filled bounding box", () => {
  const ellipse = { ...baseShape, tool: "circle", start: { x: 0, y: 0 }, end: { x: 100, y: 60 } };
  const arrow = { ...baseShape, tool: "arrow", start: { x: 0, y: 0 }, end: { x: 100, y: 100 } };

  assert.equal(isShapeHit(ellipse, { x: 50, y: 0 }, 2), true);
  assert.equal(isShapeHit(ellipse, { x: 50, y: 30 }, 2), false);
  assert.equal(isShapeHit(arrow, { x: 50, y: 52 }, 3), true);
  assert.equal(isShapeHit(arrow, { x: 50, y: 65 }, 3), false);
});

test("shape cloning keeps history snapshots isolated from later point mutations", () => {
  const original = { ...baseShape, tool: "pen", points: [{ x: 1, y: 2 }] };
  const snapshot = cloneShape(original);
  original.points[0].x = 99;

  assert.equal(snapshot.points[0].x, 1);
});

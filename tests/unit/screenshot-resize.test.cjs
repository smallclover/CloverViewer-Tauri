const assert = require("node:assert/strict");
const test = require("node:test");
const { resizeShape } = require("../../.unit-test-dist/screenshot/resize.js");

const rect = {
  tool: "rect",
  start: { x: 10, y: 20 },
  end: { x: 110, y: 80 },
  color: "#cc0000",
  strokeWidth: 2,
};
const origin = { start: { ...rect.start }, end: { ...rect.end }, strokeWidth: rect.strokeWidth };

test("resize maps rectangle corner and edge handles without mutating the source", () => {
  const resizedCorner = resizeShape(rect, origin, 0, { x: 5, y: 6 }, 4);
  const resizedEdge = resizeShape(rect, origin, 5, { x: 140, y: 999 }, 4);

  assert.deepEqual(resizedCorner.start, { x: 5, y: 6 });
  assert.deepEqual(resizedCorner.end, origin.end);
  assert.deepEqual(resizedEdge.start, origin.start);
  assert.deepEqual(resizedEdge.end, { x: 140, y: 80 });
  assert.deepEqual(rect, { ...rect, start: { x: 10, y: 20 }, end: { x: 110, y: 80 } });
});

test("resize rejects unusably small annotations and resizes arrow endpoints", () => {
  assert.equal(resizeShape(rect, origin, 2, { x: 12, y: 23 }, 4), null);
  const arrow = { ...rect, tool: "arrow" };
  const resized = resizeShape(arrow, origin, 1, { x: 150, y: 100 }, 4);

  assert.deepEqual(resized.start, origin.start);
  assert.deepEqual(resized.end, { x: 150, y: 100 });
});

test("text resizing normalizes its bounds and scales its font size within limits", () => {
  const text = { ...rect, tool: "text", strokeWidth: 12, text: "hello" };
  const textOrigin = { start: { ...text.start }, end: { ...text.end }, strokeWidth: text.strokeWidth };
  const resized = resizeShape(text, textOrigin, 2, { x: 60, y: 50 }, 4);

  assert.deepEqual(resized.start, { x: 60, y: 50 });
  assert.deepEqual(resized.end, { x: 110, y: 80 });
  assert.equal(resized.strokeWidth, 6);
});

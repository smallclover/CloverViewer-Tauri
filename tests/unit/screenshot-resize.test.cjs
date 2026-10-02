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
  assert.equal(resized.strokeWidth, 12);
  assert.equal(resized.fontSize, 22);
});

test("arrow endpoint resizing accepts axis-aligned lines and checks segment length", () => {
  const arrow = { ...rect, tool: "arrow" };
  for (const [handle, fixed] of [[0, origin.end], [1, origin.start]]) {
    for (const offset of [{ x: 40, y: 0 }, { x: 0, y: 40 }, { x: -40, y: 0 }, { x: 0, y: -40 }, { x: 3, y: 3 }]) {
      const point = { x: fixed.x + offset.x, y: fixed.y + offset.y };
      const resized = resizeShape(arrow, origin, handle, point, 4);
      assert.ok(resized);
      assert.deepEqual(handle === 0 ? resized.start : resized.end, point);
      assert.deepEqual(handle === 0 ? resized.end : resized.start, fixed);
    }
    assert.equal(resizeShape(arrow, origin, handle, fixed, 4), null);
    assert.equal(resizeShape(arrow, origin, handle, { x: fixed.x + 2, y: fixed.y + 2 }, 4), null);
  }
});

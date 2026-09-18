const assert = require("node:assert/strict");
const test = require("node:test");
const { drawAnnotation } = require("../../.unit-test-dist/screenshot/annotation-renderer.js");

function createContext() {
  const calls = [];
  const context = {
    calls,
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (x, y) => calls.push(["moveTo", x, y]),
    lineTo: (x, y) => calls.push(["lineTo", x, y]),
    stroke: () => calls.push(["stroke"]),
    strokeRect: (x, y, width, height) => calls.push(["strokeRect", x, y, width, height]),
    ellipse: (...args) => calls.push(["ellipse", ...args]),
    fillText: (text, x, y) => calls.push(["fillText", text, x, y]),
  };
  return context;
}

const baseShape = {
  tool: "rect",
  start: { x: 30, y: 40 },
  end: { x: 10, y: 20 },
  color: "#cc0000",
  strokeWidth: 2,
};

test("annotation renderer configures the stroke and normalizes rectangle bounds", () => {
  const context = createContext();
  drawAnnotation(context, baseShape, 1.5);

  assert.equal(context.strokeStyle, "#cc0000");
  assert.equal(context.fillStyle, "#cc0000");
  assert.equal(context.lineWidth, 3);
  assert.deepEqual(context.calls, [["strokeRect", 10, 20, 20, 20]]);
});

test("annotation renderer draws pen paths and arrow shafts with heads", () => {
  const penContext = createContext();
  drawAnnotation(penContext, { ...baseShape, tool: "pen", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }, 1);
  assert.deepEqual(penContext.calls, [["beginPath"], ["moveTo", 1, 2], ["lineTo", 3, 4], ["stroke"]]);

  const arrowContext = createContext();
  drawAnnotation(arrowContext, { ...baseShape, tool: "arrow", start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }, 1);
  assert.equal(arrowContext.calls.filter(([name]) => name === "stroke").length, 2);
  assert.deepEqual(arrowContext.calls.slice(0, 4), [["beginPath"], ["moveTo", 0, 0], ["lineTo", 100, 0], ["stroke"]]);
});

test("annotation renderer lays out multiline text using scaled line height", () => {
  const context = createContext();
  drawAnnotation(context, { ...baseShape, tool: "text", text: "first\nsecond" }, 2);

  assert.equal(context.font, '600 48px "Segoe UI", system-ui, sans-serif');
  assert.equal(context.textBaseline, "top");
  assert.deepEqual(context.calls, [["fillText", "first", 30, 40], ["fillText", "second", 30, 97.6]]);
});

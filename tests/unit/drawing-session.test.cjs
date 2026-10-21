const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const { createDrawingSession } = loadTs("image-editor/drawing-session.ts");
const { createFrameUpdate } = loadTs("image-editor/frame-update.ts");
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(initialTool = "arrow") {
  const events = new Map(), captured = new Set(), committed = [], adjusted = [], frames = new Map();
  let blur, tool = initialTool, paints = 0, nextFrame = 0;
  let style = { color: "red", strokeWidth: 2, blockSize: 16, arrowHeadSize: 12 };
  const canvas = {
    addEventListener: (name, callback) => events.set(name, callback),
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => { captured.delete(id); events.get("lostpointercapture")?.({ pointerId: id }); },
  };
  const render = () => { paints++; };
  const paint = createFrameUpdate(render, { request: callback => { frames.set(++nextFrame, callback); return nextFrame; }, cancel: id => frames.delete(id) });
  const drawing = createDrawingSession({
    canvas, host: { addEventListener: (_, callback) => { blur = callback; } },
    isEnabled: () => true, getTool: () => tool,
    getPoint: event => ({ x: event.clientX * 2, y: event.clientY * 2 }), getStyle: () => style,
    requestPaint: () => paint.push(undefined), discardPaint: paint.discard, invalidate() {}, render,
    commit: shape => { committed.push(shape); return committed.length - 1; }, adjust: index => adjusted.push(index),
  });
  const fire = (name, x, y, pointerId = 1) => events.get(name)({ clientX: x, clientY: y, pointerId, button: 0 });
  return { drawing, fire, captured, committed, adjusted, frames, blur: () => blur(),
    paints: () => paints, setStyle: value => { style = value; }, setTool: value => { tool = value; } };
}

test("a drawing uses its pointer's final release and ignores a second pointer and reentrant capture loss", () => {
  const f = fixture();
  f.fire("pointerdown", 10, 20);
  f.fire("pointerdown", 100, 200, 2); f.fire("pointermove", 200, 200, 2); f.fire("pointerup", 200, 200, 2);
  assert.equal(f.drawing.isDrawing(), true); assert.equal(f.committed.length, 0);
  f.setStyle({ color: "blue", strokeWidth: 8, blockSize: 48, arrowHeadSize: 30 });
  f.fire("pointerup", 30, 40);
  assert.equal(f.committed.length, 1);
  assert.deepEqual(plain(f.committed[0].end), { x: 60, y: 80 });
  assert.equal(f.committed[0].color, "red"); assert.equal(f.committed[0].arrowHeadSize, 12);
  assert.deepEqual(f.adjusted, [0]); assert.equal(f.captured.size, 0);
  assert.equal(f.drawing.current, null); assert.equal(f.drawing.isDrawing(), false);
});

test("freehand previews coalesce while all mosaic points and the returning final segment are retained", () => {
  const f = fixture("mosaic"); f.fire("pointerdown", 10, 10);
  const initialPaints = f.paints();
  f.fire("pointermove", 20, 20); f.fire("pointermove", 30, 30);
  assert.equal(f.frames.size, 1); assert.equal(f.paints(), initialPaints);
  f.fire("pointerup", 10, 10);
  assert.equal(f.frames.size, 0);
  assert.deepEqual(plain(f.committed[0].points), [{ x: 20, y: 20 }, { x: 40, y: 40 }, { x: 60, y: 60 }, { x: 20, y: 20 }]);
  assert.deepEqual(f.adjusted, []);
});

test("cancellation and blur release capture, discard queued paint and ignore late release", () => {
  for (const cancel of [f => f.fire("pointercancel", 20, 20), f => f.blur(), f => f.drawing.cancel(), f => f.drawing.reset()]) {
    const f = fixture("pen"); f.fire("pointerdown", 10, 10); f.fire("pointermove", 20, 20);
    f.fire("pointercancel", 0, 0, 2); assert.equal(f.drawing.isDrawing(), true);
    cancel(f); f.fire("pointerup", 40, 40);
    assert.equal(f.committed.length, 0); assert.equal(f.frames.size, 0); assert.equal(f.captured.size, 0);
    assert.equal(f.drawing.current, null);
    f.fire("pointerdown", 10, 10); f.fire("pointerup", 20, 20);
    assert.equal(f.committed.length, 1);
  }
});

test("selection, crop and text inputs do not start drawings; a mosaic click remains a valid stamp", () => {
  const f = fixture();
  for (const tool of ["select", "crop", "text"]) { f.setTool(tool); f.fire("pointerdown", 10, 10); assert.equal(f.drawing.current, null); }
  f.setTool("arrow"); f.fire("pointerdown", 10, 10); f.fire("pointerup", 10, 10);
  assert.equal(f.committed.length, 0);
  f.setTool("mosaic"); f.fire("pointerdown", 10, 10); f.fire("pointerup", 10, 10);
  assert.equal(f.committed.length, 1); assert.equal(f.committed[0].points.length, 1);
});

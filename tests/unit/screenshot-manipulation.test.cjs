const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const { createEditorSession } = loadTs("screenshot/editor-session.ts");
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(mode, overPanel = false) {
  const { createEditorInputController } = loadTs("screenshot/editor-input.ts", {}, {
    document: { elementFromPoint: () => overPanel ? { closest: () => true } : null },
  });
  const session = createEditorSession({ color: "red", strokeWidth: 2 });
  session.shapes = [{ tool: "rect", start: { x: 40, y: 40 }, end: { x: 70, y: 70 },
    color: "red", strokeWidth: 2 }];
  session.selection = { x: 20, y: 20, w: 100, h: 100 };
  session.selectedIndex = mode === "resize" ? 0 : null;
  const input = createEditorInputController({
    root: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 100 }) },
    canvas: { style: {} }, getBounds: () => ({ totalW: 200, totalH: 200, minX: 0, minY: 0 }),
    getScreens: () => [], getSelection: () => session.selection, setSelection: next => { session.selection = next; },
    getTool: () => null, getStyle: () => ({}), getShapes: () => session.shapes,
    getSelectedIndex: () => session.selectedIndex, setSelectedIndex: next => { session.selectedIndex = next; },
    getCurrentShape: () => null, setCurrentShape() {}, isTextEditing: () => false,
    showTextInput() {}, isScrollActive: () => false,
    hitTestShapes: () => mode === "move" ? 0 : null,
    hitHandle: () => mode === "resize" ? { index: 0, handle: 2 } : null,
    pickWindowAt: async () => null, minShapeSize: 4,
    onCheckpoint: session.checkpoint, render() {},
  });
  const event = (x, y) => ({ button: 0, clientX: 10 + x / 2, clientY: 20 + y / 2 });
  return { input, get shapes() { return session.shapes; }, session, event, selection: () => session.selection };
}

test("moving a screenshot selection keeps all annotations at a fixed relative position through repeated moves", () => {
  const f = fixture("selection");
  f.shapes.push({ tool: "pen", start: { x: 30, y: 30 }, end: { x: 80, y: 80 },
    points: [{ x: 30, y: 30 }, { x: 80, y: 80 }], rotationOrigin: { x: 55, y: 55 } });
  f.input.onMouseDown(f.event(50, 50));
  for (const [x, y] of [[60, 65], [70, 75], [70, 75], [500, 500], [50, 50]]) {
    f.input.onMouseMove(f.event(x, y));
    const selection = f.selection();
    assert.equal(f.shapes[0].start.x - selection.x, 20);
    assert.equal(f.shapes[0].start.y - selection.y, 20);
    assert.equal(f.shapes[1].points[0].x - selection.x, 10);
    assert.equal(f.shapes[1].rotationOrigin.y - selection.y, 35);
  }
  f.input.onMouseUp(f.event(80, 90));
  assert.deepEqual(plain(f.selection()), { x: 50, y: 60, w: 100, h: 100 });
  assert.deepEqual(plain(f.shapes[0].start), { x: 70, y: 80 });
});

test("screenshot move and resize commit the final release over a panel even without a mousemove", () => {
  for (const mode of ["move", "resize"]) {
    const f = fixture(mode, true), before = plain(f.shapes);
    f.input.onMouseDown(f.event(40, 40));
    f.input.onMouseUp(f.event(90, 100));
    assert.deepEqual(plain(f.shapes[0].end), mode === "move" ? { x: 120, y: 120 } : { x: 90, y: 100 });
    assert.equal(f.session.undo(), true);
    assert.deepEqual(plain(f.shapes), before);
    assert.equal(f.session.undo(), false, "exactly one history entry");
  }
});

test("undo and redo stay relative to the moved screenshot selection, including an existing redo stack", () => {
  const f = fixture("selection");
  f.session.checkpoint();
  f.shapes.push({ tool: "pen", start: { x: 30, y: 30 }, end: { x: 80, y: 80 },
    points: [{ x: 30, y: 30 }, { x: 80, y: 80 }], rotationOrigin: { x: 55, y: 55 } });
  f.input.onMouseDown(f.event(50, 50)); f.input.onMouseUp(f.event(70, 80));
  assert.equal(f.session.undo(), true);
  assert.equal(f.shapes.length, 1);
  assert.deepEqual(plain(f.shapes[0].start), { x: 60, y: 70 });
  f.input.onMouseDown(f.event(70, 80)); f.input.onMouseUp(f.event(80, 90));
  assert.equal(f.session.redo(), true);
  assert.deepEqual(plain(f.shapes[0].start), { x: 70, y: 80 });
  assert.deepEqual(plain(f.shapes[1].points[0]), { x: 60, y: 70 });
  assert.deepEqual(plain(f.shapes[1].rotationOrigin), { x: 85, y: 95 });
  f.session.selectedIndex = 0; f.session.deleteSelected(); f.session.undo();
  assert.deepEqual(plain(f.shapes[0].start), { x: 70, y: 80 });
});

test("reset clears selection-relative history and release at the original position creates no edit", () => {
  const f = fixture("move"), before = plain(f.shapes);
  f.input.onMouseDown(f.event(40, 40)); f.input.onMouseMove(f.event(60, 60));
  f.input.onMouseUp(f.event(40, 40));
  assert.deepEqual(plain(f.shapes), before); assert.equal(f.session.undo(), false);
  f.input.onMouseDown(f.event(40, 40)); f.input.onMouseUp(f.event(60, 60));
  assert.equal(f.session.undo(), true);
  f.session.reset(); assert.equal(f.session.redo(), false); assert.equal(f.session.undo(), false);
  assert.equal(f.session.selection, null);
});

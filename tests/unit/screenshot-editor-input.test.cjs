const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditorInputController } = require("../../.unit-test-dist/screenshot/editor-input.js");
const { ShapeHistory } = require("../../.unit-test-dist/screenshot/history.js");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

function draw(tool, end, moves = [end], overlap = false) {
  const shapes = [];
  if (overlap) shapes.push({ tool: "mosaic", start: { x: 50, y: 50 }, end: { x: 150, y: 50 },
    points: [{ x: 50, y: 50 }, { x: 150, y: 50 }], color: "#f00", strokeWidth: 16, blockSize: 16 });
  const history = new ShapeHistory();
  let currentShape = null;
  const controller = createEditorInputController({
    root: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }) },
    canvas: { style: {} },
    getBounds: () => ({ totalW: 200, totalH: 200, minX: 0, minY: 0 }),
    getScreens: () => [],
    getSelection: () => ({ x: 0, y: 0, w: 200, h: 200 }),
    setSelection: () => {},
    getTool: () => tool,
    getStyle: () => ({ color: "#cc0000", strokeWidth: 2, mosaicWidth: 10 }),
    getShapes: () => shapes,
    getSelectedIndex: () => null,
    setSelectedIndex: () => {},
    getCurrentShape: () => currentShape,
    setCurrentShape: (shape) => { currentShape = shape; },
    isTextEditing: () => false,
    showTextInput: () => {},
    isScrollActive: () => false,
    hitTestShapes: () => overlap ? 0 : null,
    hitHandle: () => null,
    pickWindowAt: async () => null,
    minShapeSize: 4,
    onCheckpoint: (snapshot) => history.checkpoint(snapshot),
    render: () => {},
  });
  const event = (point) => ({ button: 0, clientX: point.x, clientY: point.y });
  const previousDocument = global.document;
  global.document = { elementFromPoint: () => null };
  try {
    controller.onMouseDown(event({ x: 50, y: 50 }));
    for (const point of moves) controller.onMouseMove(event(point));
    assert.ok(currentShape, "the annotation is visible during dragging");
    controller.onMouseUp(event(end));
    assert.equal(currentShape, null, "release clears the transient preview");
  } finally {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
  return { shapes, history };
}

test("a single mosaic click retains its round stamp in undo history", () => {
  const { shapes } = draw("mosaic", { x: 50, y: 50 }, []);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].points.length, 1);
});

test("releasing horizontal, vertical and near-axis arrows retains them in undo history", () => {
  for (const end of [
    { x: 150, y: 50 }, { x: 10, y: 50 },
    { x: 50, y: 150 }, { x: 50, y: 10 },
    { x: 150, y: 51 }, { x: 51, y: 150 },
    { x: 54, y: 50 }, { x: 53, y: 53 },
  ]) {
    const { shapes, history } = draw("arrow", end);
    assert.equal(shapes.length, 1, JSON.stringify(end));
    assert.deepEqual(shapes[0].end, end);
    const undone = history.undo(shapes);
    assert.deepEqual(undone, []);
    assert.deepEqual(history.redo(undone), shapes);
  }
});

test("clicks and arrows shorter than the minimum do not create history entries", () => {
  for (const end of [{ x: 50, y: 50 }, { x: 53, y: 50 }, { x: 52, y: 52 }]) {
    const { shapes, history } = draw("arrow", end);
    assert.deepEqual(shapes, []);
    assert.equal(history.undo(shapes), null);
  }
});

test("mosaic paints a new stroke over an existing annotation instead of moving that annotation", () => {
  const { shapes } = draw("mosaic", { x: 150, y: 50 }, undefined, true);
  assert.equal(shapes.length, 2);
  assert.deepEqual(shapes[0].points, [{ x: 50, y: 50 }, { x: 150, y: 50 }]);
  assert.deepEqual(shapes[1].points, [{ x: 50, y: 50 }, { x: 150, y: 50 }]);
  assert.equal(shapes[1].blockSize, 10);
});

test("rectangles and ellipses still require both dimensions to reach the minimum", () => {
  for (const tool of ["rect", "circle"]) {
    for (const end of [{ x: 150, y: 50 }, { x: 50, y: 150 }, { x: 150, y: 53 }]) {
      assert.deepEqual(draw(tool, end).shapes, []);
    }
    assert.equal(draw(tool, { x: 54, y: 54 }).shapes.length, 1);
  }
});

test("horizontal and vertical pen and mosaic strokes survive release, including returning paths", () => {
  for (const tool of ["pen", "mosaic"]) {
    for (const end of [{ x: 150, y: 50 }, { x: 50, y: 150 }]) {
      const { shapes, history } = draw(tool, end);
      assert.equal(shapes.length, 1, tool);
      assert.deepEqual(shapes[0].points, [{ x: 50, y: 50 }, end]);
      assert.deepEqual(history.undo(shapes), []);
    }
    const { shapes } = draw(tool, { x: 50, y: 50 }, [{ x: 150, y: 50 }, { x: 50, y: 50 }]);
    assert.equal(shapes.length, 1, "the path is nonempty even when its endpoints coincide");
  }
});

test("release commits the final coordinates even when no usable mouse move arrives", () => {
  for (const tool of ["arrow", "pen", "mosaic"]) {
    for (const end of [{ x: 150, y: 50 }, { x: 50, y: 150 }]) {
      for (const moves of [[], [{ x: 51, y: 50 }]]) {
        const { shapes, history } = draw(tool, end, moves);
        assert.equal(shapes.length, 1, `${tool} with ${moves.length} moves`);
        assert.deepEqual(shapes[0].end, end);
        if (tool !== "arrow") assert.deepEqual(shapes[0].points, [{ x: 50, y: 50 }, end]);
        assert.deepEqual(history.undo(shapes), []);
      }
    }
  }
});

test("release adds the last stroke point and clamps it to the screenshot selection", () => {
  const { shapes } = draw("pen", { x: 220, y: 50 }, [{ x: 100, y: 50 }]);
  assert.equal(shapes.length, 1);
  assert.deepEqual(shapes[0].end, { x: 200, y: 50 });
  assert.deepEqual(shapes[0].points, [{ x: 50, y: 50 }, { x: 100, y: 50 }, { x: 200, y: 50 }]);
});

function hoverSetup(pick = async () => ({ x: -750, y: 40, width: 100, height: 120 }), physicalScale = 2) {
  let now = 0;
  let timerId = 0;
  let selection = null;
  let element = null;
  const timers = new Map();
  const calls = [];
  const exports = {};
  const source = readFileSync(resolve(__dirname, "../../src/screenshot/editor-input.ts"), "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports,
    require: (name) => require(`../../.unit-test-dist/screenshot/${name.slice(2)}.js`),
    performance: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    document: { elementFromPoint: () => element },
  });
  const controller = exports.createEditorInputController({
    root: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400 / physicalScale, height: 400 / physicalScale }) },
    canvas: { style: {} },
    getBounds: () => ({ totalW: 400, totalH: 400, minX: -800, minY: 0 }),
    getScreens: () => [{ x: 0, y: 0, w: 400, h: 400 }],
    getSelection: () => selection,
    setSelection: (next) => { selection = next; },
    getTool: () => null,
    getShapes: () => [],
    getSelectedIndex: () => null,
    setSelectedIndex: () => {},
    getCurrentShape: () => null,
    isTextEditing: () => false,
    isScrollActive: () => false,
    hitTestShapes: () => null,
    hitHandle: () => null,
    pickWindowAt: (x, y) => { calls.push([x, y]); return pick(x, y); },
    minShapeSize: 4,
    render: () => {},
  });
  return {
    controller, calls, timers,
    selection: () => selection,
    move: (x, y) => controller.onMouseMove({ clientX: x / physicalScale, clientY: y / physicalScale }),
    overUI: () => { element = { closest: () => ({}) }; },
    advance: async (time) => {
      now = time;
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
      await Promise.resolve();
    },
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const windowHover = { x: 50, y: 40, w: 100, h: 120 };

test("interface zoom preserves native window coordinates and physical selection dimensions", async () => {
  for (const zoom of [1, 1.1, 1.25, 1.5]) {
    const fixture = hoverSetup(undefined, zoom);
    fixture.move(80, 90);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fixture.calls, [[-720, 90]]);
    assert.deepEqual(plain(fixture.controller.getFrameState().hoverWin), windowHover);
    fixture.controller.onMouseDown({ button: 0, clientX: 80 / zoom, clientY: 90 / zoom });
    fixture.move(220, 250);
    fixture.controller.onMouseUp({ button: 0, clientX: 220 / zoom, clientY: 250 / zoom });
    const selection = fixture.selection();
    assert.ok(Math.abs(selection.x - 80) < 1e-9);
    assert.ok(Math.abs(selection.y - 90) < 1e-9);
    assert.ok(Math.abs(selection.w - 140) < 1e-9);
    assert.ok(Math.abs(selection.h - 160) < 1e-9);
  }
});

test("opening and reopening at the same stationary cursor shows a selectable window", async () => {
  const fixture = hoverSetup();
  for (let session = 0; session < 2; session++) {
    fixture.controller.reset();
    await fixture.controller.initializeCursor({ x: 80, y: 90 });
    assert.deepEqual(plain(fixture.controller.getFrameState().hoverWin), windowHover);
    assert.deepEqual(plain(fixture.controller.getFrameState().lastMousePos), { x: 80, y: 90 });
  }
  assert.deepEqual(fixture.calls, [[-720, 90], [-720, 90]]);
  const event = { button: 0, clientX: 40, clientY: 45 };
  fixture.controller.onMouseDown(event);
  fixture.controller.onMouseUp(event);
  assert.deepEqual(plain(fixture.selection()), windowHover);
});

test("rapid movement queries the final position even after movement stops", async () => {
  const fixture = hoverSetup();
  await fixture.controller.initializeCursor({ x: 80, y: 90 });
  await fixture.advance(5);
  fixture.move(120, 140);
  await fixture.advance(10);
  fixture.move(121, 141);
  assert.equal(fixture.calls.length, 1);
  await fixture.advance(40);
  assert.deepEqual(fixture.calls, [[-720, 90], [-679, 141]]);
  assert.equal(fixture.timers.size, 0);
});

test("reset cancels queued queries and ignores responses from the previous capture", async () => {
  let resolveOld;
  const fixture = hoverSetup(() => new Promise(resolve => { resolveOld = resolve; }));
  const old = fixture.controller.initializeCursor({ x: 80, y: 90 });
  fixture.move(120, 140);
  fixture.controller.reset();
  assert.equal(fixture.timers.size, 0);
  resolveOld({ x: -750, y: 40, width: 100, height: 120 });
  await old;
  await fixture.advance(40);
  assert.equal(fixture.controller.getFrameState().hoverWin, null);
  assert.equal(fixture.controller.getFrameState().lastMousePos, null);
  assert.equal(fixture.calls.length, 1);
});

test("an older response cannot replace the highlight for a newer pointer position", async () => {
  let resolveOld;
  const fixture = hoverSetup(() => new Promise(resolve => { resolveOld = resolve; }));
  const old = fixture.controller.initializeCursor({ x: 80, y: 90 });
  fixture.move(120, 140);
  resolveOld({ x: -750, y: 40, width: 100, height: 120 });
  await old;
  assert.equal(fixture.controller.getFrameState().hoverWin, null);
  fixture.controller.reset();
});

test("moving over controls cancels pending detection and clears the green frame", async () => {
  const fixture = hoverSetup();
  await fixture.controller.initializeCursor({ x: 80, y: 90 });
  fixture.move(120, 140);
  fixture.overUI();
  fixture.move(130, 150);
  await fixture.advance(40);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.controller.getFrameState().hoverWin, null);
});

test("desktop and failed native detection both fall back to the current monitor", async () => {
  for (const pick of [async () => null, async () => { throw new Error("IPC failed"); }]) {
    const fixture = hoverSetup(pick);
    await fixture.controller.initializeCursor({ x: 80, y: 90 });
    assert.deepEqual(plain(fixture.controller.getFrameState().hoverWin), { x: 0, y: 0, w: 400, h: 400 });
  }
});

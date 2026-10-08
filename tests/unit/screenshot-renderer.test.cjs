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

test("screenshot mosaic reuses immutable capture samples through drawing, commit and export", () => {
  const { createEditorCanvasRenderer } = require("../../.unit-test-dist/screenshot/editor-renderer.js");
  const canvases = [];
  const makeCanvas = () => {
    const canvas = { width: 200, height: 200 };
    const calls = [];
    const context = new Proxy({
      canvas,
      calls,
      measureText: () => ({ width: 40 }),
      getImageData: () => { throw new Error("Unexpected synchronous pixel read"); },
    }, {
      get(target, key) {
        if (key in target) return target[key];
        return (...args) => calls.push([key, ...args]);
      },
    });
    canvas.getContext = () => context;
    canvases.push(canvas);
    return canvas;
  };
  const previousDocument = global.document;
  global.document = { createElement: makeCanvas };
  try {
    const canvas = makeCanvas();
    let image = {};
    const renderer = createEditorCanvasRenderer({
      context: canvas.getContext(),
      getScreens: () => [{ image, x: 0, y: 0, w: 200, h: 200 }],
      getScale: () => 1,
      mosaicWidth: 16,
      drawMagnifier: () => {},
    });
    const shape = { ...baseShape, tool: "mosaic", blockSize: 16, points: [{ x: 42, y: 42 }] };
    const frame = {
      canvas, selection: { x: 0, y: 0, w: 200, h: 200 }, shapes: [], currentShape: shape,
      selectedIndex: null, magnifierPoint: null, windowHover: null,
    };
    renderer.render(frame);
    const source = canvases[1];
    assert.equal(renderer.background, source);
    const isSample = (args) => args.length === 6 && args[0] === "drawImage" && args[1] === source;
    const grid = canvases.find((item) => item.getContext().calls.some(isSample));
    assert.ok(grid);
    const texture = canvases.find((item) => item.getContext().calls.some(([name, from]) => name === "drawImage" && from === grid));
    const samples = () => grid.getContext().calls.filter(([name]) => name === "drawImage");
    assert.equal(samples().length, 4);
    assert.deepEqual(samples()[0].slice(1), [source, 0, 0, 12.5, 12.5]);

    shape.points.push({ x: 47, y: 47 });
    renderer.render(frame);
    assert.deepEqual(canvas.getContext().calls.filter(([name]) => name === "clearRect").at(-1),
      ["clearRect", 33, 33, 23, 23], "a new segment only refreshes its brush bounds");
    const idleCount = canvas.getContext().calls.length;
    for (let index = 0; index < 50; index++) renderer.render(frame);
    assert.equal(canvas.getContext().calls.length, idleCount, "hovering must not repaint the capture");
    renderer.render({ ...frame, shapes: [shape], currentShape: null });
    const exportContext = makeCanvas().getContext();
    renderer.drawShape(exportContext, shape);
    assert.equal(samples().length, 4);
    assert.equal(source.getContext().calls.filter(([name]) => name === "drawImage").length, 1);
    assert.deepEqual(exportContext.calls.filter(([name]) => name === "drawImage").at(-1).slice(1),
      [texture, 33, 33, 23, 23, 33, 33, 23, 23]);

    image = {};
    renderer.render({ ...frame, shapes: [shape], currentShape: null });
    assert.equal(source.getContext().calls.filter(([name]) => name === "drawImage").length, 2);
    assert.equal(texture.width, 0, "a new capture must discard previous color samples");
    const newGrid = canvases.filter((item) => item.getContext().calls.some(isSample)).at(-1);
    assert.notEqual(newGrid, grid);
    assert.equal(newGrid.getContext().calls.filter(([name]) => name === "drawImage").length, 4);
    const beforeSelection = canvas.getContext().calls.length;
    for (let index = 0; index < 120; index++) renderer.render({ ...frame, shapes: [shape], currentShape: null,
      selection: { x: index, y: index, w: 150 - index, h: 150 - index },
      magnifierPoint: { x: index, y: index }, windowHover: { x: 0, y: 0, w: index, h: index },
    });
    assert.equal(canvas.getContext().calls.length, beforeSelection, "selection and magnifier motion do not repaint annotations or copy the desktop");
    assert.equal(canvas.getContext().calls.some(([name, image]) => name === "drawImage" && image === source), false);
    renderer.setVisible(true);
    assert.equal(source.hidden, false);
    renderer.setVisible(false);
    assert.equal(source.hidden, true, "scroll capture must hide the static background");
    renderer.reset();
    assert.equal(source.width, 0);
    assert.equal(newGrid.width, 0);
  } finally {
    global.document = previousDocument;
  }
});

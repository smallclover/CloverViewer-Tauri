const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");
const { createAnnotationSizes, imageAnnotationSizes, SIZE_PRESETS, sizeKind } = require("../../.unit-test-dist/compiled/image-editor/annotation-style.js");
const { resizeShape } = require("../../.unit-test-dist/compiled/screenshot/resize.js");

test("tool changes retain independent font, stroke and mosaic sizes", () => {
  const sizes = createAnnotationSizes();
  sizes[sizeKind("text")] = 48;
  sizes[sizeKind("pen")] = 6;
  sizes[sizeKind("mosaic")] = 32;
  assert.equal(sizes[sizeKind("text")], 48);
  for (const tool of ["rect", "circle", "arrow", "pen"]) assert.equal(sizes[sizeKind(tool)], 6);
  assert.equal(sizes[sizeKind("mosaic")], 32);
});

test("new annotation defaults and every preset retain their screen size at every preview zoom", () => {
  for (const scale of [0.05, 0.2, 0.25, 0.75, 1, 2, 8, 40]) {
    for (const [kind, presets] of Object.entries(SIZE_PRESETS)) {
      for (const target of presets) {
        const selected = { ...createAnnotationSizes(), [kind]: target };
        const converted = imageAnnotationSizes(selected, scale);
        assert.ok(Math.abs(converted[kind] * scale - target) < 0.00001);
        assert.equal(selected[kind], target, "conversion does not change the toolbar selection");
      }
    }
    const converted = imageAnnotationSizes(createAnnotationSizes(), scale);
    assert.equal(converted.arrowHeadSize * scale, 16);
  }
  for (const scale of [0, NaN, Infinity, -1]) {
    const { arrowHeadSize, ...sizes } = imageAnnotationSizes(createAnnotationSizes(), scale);
    assert.deepEqual(sizes, createAnnotationSizes());
    assert.equal(arrowHeadSize, 16);
  }
  assert.deepEqual(createAnnotationSizes(), {strokeWidth: 2, fontSize: 24, blockSize: 16});
});

test("arrow heads and strokes use the captured image size in both preview and export", () => {
  const { drawAnnotation } = require("../../.unit-test-dist/compiled/image-editor/annotation-renderer.js");
  for (const zoom of [0.2, 1, 2, 40]) {
    const moves = [];
    const context = { beginPath() {}, moveTo: (...args) => moves.push(args), lineTo() {}, stroke() {} };
    const shape = { tool: "arrow", start: {x: 0, y: 100}, end: {x: 200, y: 100}, color: "red",
      ...imageAnnotationSizes(createAnnotationSizes(), zoom) };
    drawAnnotation(context, shape);
    assert.equal(context.lineWidth * zoom, 2);
    assert.ok(Math.abs((shape.end.x - moves[1][0]) * zoom - 16) < 0.00001);
    assert.ok(Math.abs((moves[1][1] - shape.end.y) * zoom - 8) < 0.00001);
  }
});

test("screenshot preview and export use image pixels regardless of interface scale", () => {
  const { createEditorCanvasRenderer } = require("../../.unit-test-dist/compiled/screenshot/editor-renderer.js");
  const previousDocument = global.document;
  const stamps = [];
  global.document = { createElement: () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => new Proxy({ canvas }, { get: (target, key) => target[key] ?? (() => {}) });
    return canvas;
  } };
  try {
    const shape = { start: { x: 100, y: 100 }, end: { x: 200, y: 200 }, color: "#f00", strokeWidth: 3 };
    for (const scale of [1, 1.25, 2]) {
      const context = { canvas: { width: 200, height: 200 }, strokeRect: () => {}, fillText: () => {},
        save: () => {}, restore: () => {}, clearRect: () => {}, drawImage: (...args) => stamps.push(args.slice(5)) };
      for (const key of ["beginPath", "moveTo", "arc", "closePath", "clip"]) context[key] = () => {};
      const image = {};
      const renderer = createEditorCanvasRenderer({ context, getScreens: () => [{ image, x: 0, y: 0, w: 200, h: 200 }], getScale: () => scale,
        mosaicWidth: 16, drawMagnifier: () => {} });
      renderer.drawShape(context, { ...shape, tool: "rect" });
      assert.equal(context.lineWidth, 3);
      renderer.drawShape(context, { ...shape, tool: "text", fontSize: 48, text: "Hello" });
      assert.ok(context.font.startsWith("600 48px"));
      renderer.drawShape(context, { ...shape, tool: "mosaic", blockSize: 24, points: [shape.start] });
      assert.deepEqual(stamps.at(-1), [87, 87, 26, 26]);
    }
  } finally { global.document = previousDocument; }
});

test("text resize scales its explicit font proportionally and retains the stroke setting", () => {
  const shape = { tool: "text", start: { x: 0, y: 0 }, end: { x: 100, y: 50 },
    color: "#f00", strokeWidth: 3, fontSize: 24, text: "Hello" };
  const enlarged = resizeShape(shape, shape, 0, { x: 200, y: 100 }, 4);
  assert.equal(enlarged.fontSize, 48);
  assert.equal(enlarged.strokeWidth, 3);
  assert.equal(shape.fontSize, 24);
});

test("screenshot text input matches the scaled preview and captures its own size and color", () => {
  const classes = new Set();
  const listeners = {};
  const timers = [];
  const shapes = [];
  const element = { style: {}, value: "", scrollHeight: 0, classList: {
    add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
  }, addEventListener: (name, handler) => { listeners[name] = handler; }, focus: () => {} };
  const source = readFileSync(resolve(__dirname, "../../src/screenshot/text-input.ts"), "utf8");
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, document: { createElement: tag => tag === "textarea" ? element : { style: {}, appendChild: () => {} } },
    window: { addEventListener: () => {} }, setTimeout: callback => timers.push(callback),
    require: () => require("../../.unit-test-dist/compiled/image-editor/annotation-style.js"),
  });
  const style = { color: "#f00", strokeWidth: 2, fontSize: 32 };
  const context = { measureText: text => ({ width: text.length * 16 }) };
  const input = exports.createTextInputController({ uiLayer: { appendChild: () => {} },
    root: { getBoundingClientRect: () => ({ width: 960, height: 540 }) }, context,
    getCanvasSize: () => ({ width: 1920, height: 1080 }), getStyle: () => style,
    getScale: () => 2, getPrompt: () => "Enter annotation text:", onCommit: shape => shapes.push(shape), onRender: () => {} });
  input.show({ x: 100, y: 80 });
  assert.ok(element.style.font.startsWith("600 16px"));
  style.fontSize = 72; style.color = "#000";
  element.value = "中文";
  const event = { key: "Enter", isComposing: true, stopPropagation: () => {}, preventDefault: () => {} };
  listeners.keydown(event);
  assert.equal(shapes.length, 0);
  input.commit();
  assert.equal(shapes[0].fontSize, 32);
  assert.equal(shapes[0].color, "#f00");
  assert.equal(shapes[0].start.x, 100);
  assert.equal(shapes[0].end.x, 132);
});

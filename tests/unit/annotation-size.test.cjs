const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");
const { createAnnotationSizes, createPreviewAnnotationSizing, sizeKind } = require("../../.unit-test-dist/image-editor/annotation-style.js");
const { resizeShape } = require("../../.unit-test-dist/screenshot/resize.js");

test("tool changes retain independent font, stroke and mosaic sizes", () => {
  const sizes = createAnnotationSizes();
  sizes[sizeKind("text")] = 48;
  sizes[sizeKind("pen")] = 6;
  sizes[sizeKind("mosaic")] = 32;
  assert.equal(sizes[sizeKind("text")], 48);
  for (const tool of ["rect", "circle", "arrow", "pen"]) assert.equal(sizes[sizeKind(tool)], 6);
  assert.equal(sizes[sizeKind("mosaic")], 32);
});

test("image-editor defaults and every size preset stay legible in fitted large-image previews", () => {
  for (const scale of [1, 0.75, 0.25, 0.2, 0.05]) {
    const { sizes, presets } = createPreviewAnnotationSizing(scale);
    for (const [kind, target] of Object.entries(createAnnotationSizes())) {
      assert.ok(Math.abs(sizes[kind] * scale - target) <= scale / 2 + 0.00001);
      assert.ok(presets[kind].includes(sizes[kind]), "adapted default must be selectable");
      assert.ok(presets[kind].every(size => Number.isInteger(size) && size > 0));
    }
  }
  for (const scale of [0, NaN, Infinity, -1, 2]) {
    assert.deepEqual(createPreviewAnnotationSizing(scale).sizes, createAnnotationSizes());
  }
  assert.deepEqual(createAnnotationSizes(), {strokeWidth: 2, fontSize: 24, blockSize: 16});
});

test("screenshot preview and export use image pixels regardless of interface scale", () => {
  const { createEditorCanvasRenderer } = require("../../.unit-test-dist/screenshot/editor-renderer.js");
  const previousDocument = global.document;
  const stamps = [];
  global.document = { createElement: () => ({ getContext: () => new Proxy({
    getImageData: () => ({ data: [0, 0, 0, 255] }),
  }, { get: (target, key) => target[key] ?? (() => {}) }) }) };
  try {
    const shape = { start: { x: 100, y: 100 }, end: { x: 200, y: 200 }, color: "#f00", strokeWidth: 3 };
    for (const scale of [1, 1.25, 2]) {
      const context = { strokeRect: () => {}, fillText: () => {}, fillRect: (...args) => stamps.push(args) };
      const renderer = createEditorCanvasRenderer({ context, getScreens: () => [], getScale: () => scale,
        mosaicWidth: 16, drawMagnifier: () => {} });
      renderer.drawShape(context, { ...shape, tool: "rect" });
      assert.equal(context.lineWidth, 3);
      renderer.drawShape(context, { ...shape, tool: "text", fontSize: 48, text: "Hello" });
      assert.ok(context.font.startsWith("600 48px"));
      renderer.drawShape(context, { ...shape, tool: "mosaic", blockSize: 24, points: [shape.start] });
      assert.deepEqual(stamps.at(-1), [88, 88, 24, 24]);
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
  const element = { style: {}, value: "", classList: {
    add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
  }, addEventListener: (name, handler) => { listeners[name] = handler; }, focus: () => {} };
  const source = readFileSync(resolve(__dirname, "../../src/screenshot/text-input.ts"), "utf8");
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, document: { createElement: () => element }, setTimeout: callback => timers.push(callback),
    require: () => require("../../.unit-test-dist/image-editor/annotation-style.js"),
  });
  const style = { color: "#f00", strokeWidth: 2, fontSize: 32 };
  const context = { measureText: text => ({ width: text.length * 16 }) };
  const input = exports.createTextInputController({ uiLayer: { appendChild: () => {} },
    root: { getBoundingClientRect: () => ({ width: 960, height: 540 }) }, context,
    getCanvasSize: () => ({ width: 1920, height: 1080 }), getStyle: () => style,
    getScale: () => 2, onCommit: shape => shapes.push(shape), onRender: () => {} });
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

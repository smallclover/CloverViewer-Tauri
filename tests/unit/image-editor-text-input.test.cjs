const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

async function setup() {
  const timers = [];
  const drawn = [];
  let active = null;
  let toolbarActions;
  let toolbar;
  let previewScale = 0.2;
  const elements = [];
  const context = new Proxy({ measureText: text => ({ width: text.length * 24 }) }, { get: (target, key) => target[key] ?? (() => {}) });
  function element(tag) {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      tag, style: {}, value: "", scrollLeft: 0, scrollTop: 0, width: 2000, height: 1000,
      get className() { return [...classes].join(" "); },
      set className(value) { classes.clear(); for (const name of value.split(" ")) classes.add(name); },
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: name => classes.delete(name), contains: name => classes.has(name) },
      append: () => {}, replaceChildren: () => {},
      getContext: () => context,
      getBoundingClientRect: () => tag === "canvas"
        ? { left: 120, top: 80, width: 2000 * previewScale, height: 1000 * previewScale }
        : { left: 100, top: 50, width: 700, height: 500 },
      addEventListener: (name, handler) => listeners.set(name, handler),
      fire: (name, event = {}) => listeners.get(name)?.(event),
      focus: () => { if (active && active !== el) active.blur(); active = el; },
      blur: () => { if (active !== el) return; active = null; el.fire("blur"); },
      setPointerCapture: () => { el.captured = true; },
    };
    elements.push(el);
    return el;
  }
  const root = element("root");
  root.classList.add("hidden");
  const exports = {};
  const source = readFileSync(resolve(__dirname, "../../src/viewer/image-editor-controller.ts"), "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports,
    document: { createElement: element },
    window: { addEventListener: () => {}, setTimeout: callback => timers.push(callback), confirm: () => true },
    require: name => {
      if (name === "@tauri-apps/plugin-dialog") return { save: async () => null };
      if (name === "../image-editor/toolbar") return { createEditorToolbar: actions => {
        toolbarActions = actions;
        toolbar = { color: { value: "#ff0000" }, sizes: { strokeWidth: 2, fontSize: 24, blockSize: 16 }, format: { value: "png" }, outputScale: { value: "100" },
          refreshTranslations: () => {}, refreshHistory: () => {}, setActiveTool: () => {}, closePanels: () => {}, updateLayout: () => {},
          initializeSizes: scale => {
            assert.equal(root.classList.contains("hidden"), false, "measure the visible editor");
            const { createPreviewAnnotationSizing } = require("../../.unit-test-dist/image-editor/annotation-style.js");
            Object.assign(toolbar.sizes, createPreviewAnnotationSizing(scale).sizes);
          } };
        return toolbar;
      } };
      if (name === "./image-editor-loader") return { createImageEditorLoader: () => ({
        load: async () => ({ naturalWidth: 2000, naturalHeight: 1000 }), cancel: () => {}, isLoading: () => false,
      }) };
      if (name === "../image-editor/crop-overlay") return { createCropOverlay: () => ({ refreshImage: () => {}, cancel: () => {} }) };
      if (name === "../image-editor/annotation-renderer") return { drawAnnotation: (_target, shape) => drawn.push(shape) };
      if (name === "../image-editor/canvas-mosaic-renderer") return { createCanvasMosaicRenderer: () => ({}) };
      return require(`../../.unit-test-dist/image-editor/${name.split("/").pop()}.js`);
    },
  });
  const controller = exports.createImageEditorController({
    root, getEditableSource: async () => "", saveImage: async () => {}, translate: key => key,
    onClose: () => {}, onSaved: () => {}, toast: () => {},
  });
  await controller.open({ path: "image.png", name: "image.png" }, () => {});
  toolbarActions.setTool("text");
  const canvas = elements.find(el => el.className === "image-editor-canvas");
  const input = elements.find(el => el.tag === "textarea");
  const click = (x = 300, y = 160) => {
    const event = { clientX: x, clientY: y, button: 0, pointerId: 1, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; } };
    canvas.fire("pointerdown", event);
    // 模拟浏览器默认行为：pointerdown 处理器返回后，未 preventDefault 才发生焦点切换。
    if (!event.defaultPrevented) active?.blur();
    return event;
  };
  const key = overrides => {
    const event = { key: "Enter", isComposing: false, keyCode: 13, shiftKey: false, prevented: false,
      stopPropagation: () => {}, preventDefault() { this.prevented = true; }, ...overrides };
    input.fire("keydown", event);
    return event;
  };
  return { controller, input, canvas, click, key, drawn, toolbarActions, toolbar,
    resizePreview: scale => { previewScale = scale; },
    flush: () => { while (timers.length) timers.shift()(); }, focused: () => active === input };
}

test("clicking the image keeps the text field open and focuses after pointer default handling", async () => {
  const fixture = await setup();
  assert.equal(fixture.click().defaultPrevented, true);
  assert.equal(fixture.canvas.captured, undefined);
  assert.equal(fixture.input.classList.contains("hidden"), false);
  assert.equal(fixture.focused(), false);
  fixture.flush();
  assert.equal(fixture.focused(), true);
  assert.equal(fixture.input.style.left, "200px");
  assert.equal(fixture.input.style.top, "110px");
  assert.equal(parseFloat(fixture.input.style.font.split(" ")[1]), 24);
  fixture.input.value = "输入文字";
  fixture.key();
  assert.equal(fixture.input.classList.contains("hidden"), true);
  assert.equal(fixture.drawn[0].text, "输入文字");
  assert.equal(fixture.drawn[0].start.x, 900);
  assert.equal(fixture.drawn[0].start.y, 400);
  assert.equal(fixture.drawn[0].fontSize, 120);
  assert.equal(fixture.drawn[0].strokeWidth, 10);
  assert.equal(fixture.drawn[0].end.x, 996);
  assert.equal(fixture.drawn[0].end.y, 544);
});

test("manual sizes and committed annotations survive tool switching and later preview resizing", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush(); fixture.input.value = "First"; fixture.key();
  const first = JSON.stringify(fixture.drawn[0]);
  fixture.toolbar.sizes.fontSize = 160;
  fixture.toolbar.sizes.strokeWidth = 20;
  fixture.toolbarActions.setTool("rect");
  fixture.toolbarActions.setTool("text");
  fixture.resizePreview(0.1);
  fixture.click(); fixture.flush(); fixture.input.value = "Second"; fixture.key();
  assert.equal(parseFloat(fixture.input.style.font.split(" ")[1]), 16);
  assert.equal(fixture.toolbar.sizes.fontSize, 160);
  assert.equal(fixture.toolbar.sizes.strokeWidth, 20);
  assert.equal(fixture.drawn.at(-1).fontSize, 160);
  assert.equal(fixture.drawn.at(-1).strokeWidth, 20);
  assert.equal(JSON.stringify(fixture.drawn[0]), first);
});

test("IME confirmation and Shift+Enter remain in the text field; a normal Enter commits", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush(); fixture.input.value = "中文";
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
    assert.equal(fixture.key(options).prevented, false);
    assert.equal(fixture.input.classList.contains("hidden"), false);
    assert.equal(fixture.drawn.length, 0);
  }
  fixture.key();
  assert.equal(fixture.drawn.length, 1);
});

test("new text clicks preserve previous text and cancellation cannot be undone by a late focus timer", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush(); fixture.input.value = "第一段";
  fixture.click(400, 200);
  assert.equal(fixture.drawn[0].text, "第一段");
  fixture.key({ key: "Escape" }); fixture.flush();
  assert.equal(fixture.input.classList.contains("hidden"), true);
  fixture.click(); fixture.toolbarActions.setTool("rect"); fixture.flush();
  assert.equal(fixture.input.classList.contains("hidden"), true);
});

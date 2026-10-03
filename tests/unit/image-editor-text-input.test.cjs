const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

async function setup() {
  const timers = [];
  const frames = new Map();
  let frameId = 0;
  const drawn = [];
  const cleared = [];
  let active = null;
  let toolbarActions;
  let toolbar;
  let previewScale = 0.2;
  const elements = [];
  const context = new Proxy({ measureText: text => ({ width: text.length * 24 }),
    clearRect: (...args) => cleared.push(args) }, { get: (target, key) => target[key] ?? (() => {}) });
  function element(tag) {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      tag, style: {}, value: "", scrollLeft: 0, scrollTop: 0, scrollHeight: 0, width: 2000, height: 1000,
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
      hasPointerCapture: () => !!el.captured,
      releasePointerCapture: () => { el.captured = false; },
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
        toolbar = { color: { value: "#ff0000" }, width: { addEventListener: () => {} }, sizes: { strokeWidth: 2, fontSize: 24, blockSize: 16 }, format: { value: "png" }, outputScale: { value: "100" },
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
      if (name === "../image-editor/mosaic-cursor") return { createMosaicCursor: () => ({ refresh: () => {}, reset: () => {} }) };
      if (name === "../image-editor/annotation-renderer") return { drawAnnotation: (_target, shape) => drawn.push(shape) };
      if (name === "../image-editor/annotation-layers") {
        const layerExports = {};
        runInNewContext(readFileSync(resolve(__dirname, "../../.unit-test-dist/image-editor/annotation-layers.js"), "utf8"), {
          exports: layerExports, document: { createElement: element },
        });
        return layerExports;
      }
      if (name === "../image-editor/frame-update") return { createFrameUpdate: apply =>
        require("../../.unit-test-dist/image-editor/frame-update.js").createFrameUpdate(apply, {
          request: callback => { frames.set(++frameId, callback); return frameId; },
          cancel: id => frames.delete(id),
        }) };
      if (name === "../image-editor/canvas-mosaic-renderer") return {
        mosaicBlockSize: shape => shape.blockSize,
        createCanvasMosaicRenderer: () => ({ reset: () => {},
          drawSegment: (_target, start, end) => drawn.push({ tool: "mosaic-segment", start, end }),
          drawShape: (_target, shape) => drawn.push(shape),
        }),
      };
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
  return { controller, input, canvas, click, key, drawn, cleared, toolbarActions, toolbar,
    paint: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
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
  assert.equal(fixture.input.style.left, "191px");
  assert.equal(fixture.input.style.top, "103px");
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

test("mosaic retains every input point, paints once per frame and commits a returning stroke", async () => {
  const fixture = await setup();
  fixture.toolbarActions.setTool("mosaic");
  fixture.click(300, 160);
  fixture.drawn.length = 0;
  for (let index = 1; index <= 20; index++) fixture.canvas.fire("pointermove", {
    clientX: 300 + index, clientY: 160 + index, pointerId: 1,
  });
  assert.equal(fixture.drawn.length, 0, "input events only queue a display frame");
  fixture.paint();
  assert.equal(fixture.drawn.length, 20);
  const region = fixture.cleared.at(-1);
  assert.ok(region[2] < 200 && region[3] < 200, "editor refreshes only the newly painted region");
  fixture.canvas.fire("pointerup", { clientX: 300, clientY: 160, pointerId: 1 });
  const committed = fixture.drawn.find(item => item.tool === "mosaic");
  assert.ok(committed, "a stroke returning to its origin must be kept");
  assert.equal(committed.points.length, 22);
  fixture.paint();
  assert.equal(fixture.drawn.filter(item => item.tool === "mosaic").length, 1);
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

test("text input grows for explicit lines without changing the annotation origin or wrapping on export", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush();
  assert.equal(fixture.input.rows, 1);
  assert.equal(fixture.input.wrap, "off");
  assert.equal(fixture.input.style.width, "180px");
  assert.equal(fixture.input.style.height, "44px");
  const originalHeight = parseFloat(fixture.input.style.height);
  fixture.input.value = "Long text ".repeat(8) + "\nSecond line";
  fixture.input.fire("input");
  assert.ok(parseFloat(fixture.input.style.width) > 260);
  assert.ok(parseFloat(fixture.input.style.height) > originalHeight);
  assert.equal(fixture.input.style.left, "191px");
  assert.equal(fixture.input.style.top, "103px");
  fixture.key();
  assert.equal(fixture.drawn[0].start.x, 900);
  assert.equal(fixture.drawn[0].start.y, 400);
  assert.equal(fixture.drawn[0].text.split("\n").length, 2);
});

test("deleting text shrinks the box back to its default size and a new input starts at that size", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush();
  fixture.input.value = "Long text ".repeat(8) + "\nSecond line";
  fixture.input.fire("input");
  assert.ok(parseFloat(fixture.input.style.width) > 180);
  assert.ok(parseFloat(fixture.input.style.height) > 44);
  fixture.input.value = "Short";
  fixture.input.fire("input");
  assert.equal(fixture.input.style.width, "180px");
  assert.equal(fixture.input.style.height, "44px");
  fixture.key();
  fixture.click(400, 200); fixture.flush();
  assert.equal(fixture.input.value, "");
  assert.equal(fixture.input.style.width, "180px");
  assert.equal(fixture.input.style.height, "44px");
});

test("an edge-clamped input commits text at its visible origin and caps overflowing content", async () => {
  const fixture = await setup();
  fixture.resizePreview(1);
  fixture.click(790, 540); fixture.flush();
  fixture.input.value = "Long text ".repeat(12) + "\nSecond line\nThird line";
  fixture.input.fire("input");
  const left = parseFloat(fixture.input.style.left);
  const top = parseFloat(fixture.input.style.top);
  assert.ok(left + parseFloat(fixture.input.style.width) <= 692);
  assert.ok(top + parseFloat(fixture.input.style.height) <= 492);
  fixture.key();
  const start = fixture.drawn[0].start;
  assert.equal(start.x, left + 9 - 20);
  assert.equal(start.y, top + 7 - 30);
});

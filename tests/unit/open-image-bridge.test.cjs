const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

async function harness(ready = true) {
  const events = [];
  let receive;
  const toast = (message, kind, persistent) => events.push({ toast: message, kind, persistent });
  toast.hide = () => events.push({ hide: true });
  const bridge = {};
  runInNewContext(compile(readFileSync(resolve(__dirname, "../../src/ui/app-bridges.ts"), "utf8")), {
    exports: bridge,
    require: (name) => name === "../api" ? {
      listenOpenImage: async (handler) => { receive = handler; },
    } : {},
  });

  const source = readFileSync(resolve(__dirname, "../../src/main.ts"), "utf8");
  const start = source.indexOf("  void bindOpenImageBridge(");
  const end = source.indexOf("  void showStartupNotices(", start);
  assert.ok(start >= 0 && end > start, "main viewer bridge binding must be present");
  const entry = { path: "C:/captures/image.png" };
  let bound;
  runInNewContext(compile(source.slice(start, end)), {
    bindOpenImageBridge: (...args) => { bound = bridge.bindOpenImageBridge(...args); },
    openFileOrFolder: async (path) => events.push({ opened: path }),
    viewerSession: { images: [entry] },
    imageOcrController: {
      setResult: (path, text) => {
        assert.equal(typeof text, "string", "only OCR strings may enter the text controller");
        events.push({ ocr: text, path });
      },
    },
    openImageOcr: (image) => events.push({ panel: image.path }),
    singleImagePresenter: { whenReady: async () => { events.push({ ready }); return ready; } },
    requestAnimationFrame: (callback) => { callback(); },
    t: (key) => key,
    toast,
  });
  await bound;
  return { receive, events };
}

test("ordinary screenshots with null OCR and scrolling captures without OCR open as images", async () => {
  for (const payload of [
    { path: "C:/captures/image.png", ocr_text: null },
    { path: "C:/captures/image.png" },
  ]) {
    const { receive, events } = await harness();
    await receive(payload);
    assert.deepEqual(events, [
      { opened: payload.path },
      { toast: "toast.opened", kind: "success", persistent: undefined },
    ]);
  }
});

test("OCR screenshots retain text, open the text panel and wait for the image before hiding progress", async () => {
  const { receive, events } = await harness();
  await receive({ path: "C:\\captures\\IMAGE.png", ocr_text: "识别文字\nRecognized text" });
  assert.deepEqual(events, [
    { toast: "toast.openingOcr", kind: "progress", persistent: true },
    { opened: "C:\\captures\\IMAGE.png" },
    { ocr: "识别文字\nRecognized text", path: "C:/captures/image.png" },
    { panel: "C:/captures/image.png" },
    { ready: true },
    { hide: true },
  ]);
});

test("an OCR image that fails to display leaves an error instead of reporting success", async () => {
  const { receive, events } = await harness(false);
  await receive({ path: "C:/captures/image.png", ocr_text: "Text" });
  assert.equal(events.at(-1).kind, "error");
  assert.match(events.at(-1).toast, /toast.openFailed/);
  assert.equal(events.some((event) => event.hide), false);
});

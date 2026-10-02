const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");
const { createScreenshotRefreshController } = require("../../.unit-test-dist/screenshot/refresh-controller.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(overrides = {}) {
  const calls = [];
  const controller = createScreenshotRefreshController({
    refreshConfig: async () => { calls.push("config"); },
    loadScreenshot: async () => { calls.push("load"); return 1; },
    showScreenshot: async (captureId) => { assert.equal(captureId, 1); calls.push("show"); return true; },
    clearScreenshot: () => { calls.push("clear"); },
    applyScrollStartMode: async () => { calls.push("mode"); },
    ...overrides,
  });
  return { controller, calls };
}

test("preloaded screenshot page without a capture stays hidden", async () => {
  const { controller, calls } = setup({ loadScreenshot: async () => null });
  await controller.refresh();
  assert.deepEqual(calls, ["config"]);
  await controller.refresh();
  assert.deepEqual(calls, ["config", "config"]);
});

test("first real capture shows only after loading and then applies scroll mode", async () => {
  const { controller, calls } = setup();
  await controller.refresh();
  assert.deepEqual(calls, ["config", "load", "show", "mode"]);
});

test("an obsolete capture rejected by the backend does not consume the next scroll mode", async () => {
  const { controller, calls } = setup({ showScreenshot: async () => false });
  await controller.refresh();
  assert.deepEqual(calls, ["config", "load"]);
});

test("closing during screenshot decode prevents a late show; next capture still works", async () => {
  const decoded = deferred();
  const loading = deferred();
  let first = true;
  const { controller, calls } = setup({ loadScreenshot: async () => {
    if (!first) return 1;
    first = false;
    loading.resolve();
    return decoded.promise;
  } });
  const refresh = controller.refresh();
  await loading.promise;
  controller.clear();
  decoded.resolve(1);
  await refresh;
  assert.equal(calls.includes("show"), false);
  await controller.refresh();
  assert.equal(calls.filter((call) => call === "show").length, 1);
});

test("refresh during startup is coalesced and never runs two screenshot loads together", async () => {
  const decoded = deferred();
  const loading = deferred();
  let loads = 0;
  let active = 0;
  let maximum = 0;
  const { controller, calls } = setup({ loadScreenshot: async () => {
    loads++;
    maximum = Math.max(maximum, ++active);
    if (loads === 1) { loading.resolve(); await decoded.promise; }
    active--;
    return 1;
  } });
  const startup = controller.refresh();
  await loading.promise;
  const hotkey = controller.refresh();
  controller.refresh();
  decoded.resolve();
  await Promise.all([startup, hotkey]);
  assert.equal(maximum, 1);
  assert.equal(loads, 2);
  assert.equal(calls.filter((call) => call === "show").length, 1);
});

function setupLoader(data, loadScreenshotScreens = async () => [], overrides = {}) {
  const calls = [];
  const classes = new Set();
  const exports = {};
  const source = readFileSync(resolve(__dirname, "../../src/screenshot/screenshot-load-controller.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, {
    exports,
    console: { error: () => {} },
    require: (name) => {
      if (name === "../api") return { getScreenshotData: async () => data, closeScreenshot: async (completed, captureId) => {
        assert.equal(completed, false);
        assert.equal(captureId, data.capture_id);
        calls.push("close");
      } };
      if (name === "./screenshot-loader") return { loadScreenshotScreens, releaseScreenshotScreens: () => {} };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    document: { body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } },
  });
  const controller = exports.createScreenshotLoadController({
    root: {}, canvas: {},
    resetSession: () => calls.push("reset"),
    setBounds: () => calls.push("bounds"),
    setInitialCursor: async () => calls.push("cursor"),
    setScreens: () => calls.push("screens"),
    logLoaded: () => {},
    render: () => calls.push("render"),
    restoreRunningScrollSession: async () => {
      assert.equal(classes.has("ready"), false);
      calls.push("restore");
    },
    ...overrides,
  });
  return { controller, calls, classes };
}

const screenshotData = { capture_id: 1, min_x: -800, min_y: 0, total_width: 1600, total_height: 600, cursor: null };

test("warmup with no screenshot does not reset or mark the page ready", async () => {
  const { controller, calls, classes } = setupLoader(null);
  assert.equal(await controller.load(), null);
  assert.deepEqual(calls, []);
  assert.equal(classes.has("ready"), false);
});

test("cancelled image decoding cannot overwrite the cleared session", async () => {
  const decoding = deferred();
  const started = deferred();
  const { controller, calls, classes } = setupLoader(screenshotData, async () => {
    started.resolve();
    return decoding.promise;
  });
  const loading = controller.load();
  await started.promise;
  controller.cancel();
  decoding.resolve([]);
  assert.equal(await loading, null);
  assert.deepEqual(calls, []);
  assert.equal(classes.has("ready"), false);
});

test("valid screenshot renders before the page is marked ready", async () => {
  const { controller, calls, classes } = setupLoader(screenshotData);
  assert.equal(await controller.load(), 1);
  assert.deepEqual(calls, ["reset", "bounds", "screens", "cursor", "render", "restore"]);
  assert.equal(classes.has("ready"), true);
});

test("initial cursor detection finishes before showing, using screenshot-local physical coordinates", async () => {
  const detected = deferred();
  const started = deferred();
  const { controller, calls, classes } = setupLoader({
    ...screenshotData, cursor: { x: -700, y: 80 },
  }, async () => [], {
    setInitialCursor: async (cursor) => {
      assert.equal(cursor.x, 100);
      assert.equal(cursor.y, 80);
      assert.deepEqual(calls, ["reset", "bounds", "screens"]);
      started.resolve();
      await detected.promise;
    },
  });
  const loading = controller.load();
  await started.promise;
  assert.equal(classes.has("ready"), false);
  assert.equal(calls.includes("render"), false);
  detected.resolve();
  assert.equal(await loading, 1);
  assert.equal(classes.has("ready"), true);
});

test("closing during initial window detection cannot show the cancelled screenshot", async () => {
  const detected = deferred();
  const started = deferred();
  const { controller, calls, classes } = setupLoader(screenshotData, async () => [], {
    setInitialCursor: async () => { started.resolve(); await detected.promise; },
  });
  const loading = controller.load();
  await started.promise;
  controller.cancel();
  detected.resolve();
  assert.equal(await loading, null);
  assert.equal(classes.has("ready"), false);
  assert.equal(calls.includes("render"), false);
});

test("failed pixel transfer closes only its own capture and never marks a blank frame ready", async () => {
  const { controller, calls, classes } = setupLoader(screenshotData, async () => {
    throw new Error("Screenshot session has expired");
  });
  assert.equal(await controller.load(), null);
  assert.deepEqual(calls, ["close"]);
  assert.equal(classes.has("ready"), false);
});

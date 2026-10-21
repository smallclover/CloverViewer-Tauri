const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");
const { createScreenshotRefreshController } = require("../../.unit-test-dist/compiled/screenshot/refresh-controller.js");

test("screenshot lifecycle awaits every API subscription before loading and routes subsequent events", async () => {
  const loadTs = require("./helpers/load-ts.cjs");
  const handlers = {}, calls = [];
  const subscribing = deferred();
  const subscribed = deferred();
  const subscribe = name => async handler => {
    handlers[name] = handler;
    if (name === "done") { subscribed.resolve(); await subscribing.promise; }
    calls.push(`listen:${name}`);
    return () => {};
  };
  const { startScreenshotLifecycle } = loadTs("screenshot/lifecycle.ts", {
    "../api": {
      listenScreenshotRefresh: subscribe("refresh"), listenScreenshotClear: subscribe("clear"),
      listenScrollCaptureProgress: subscribe("progress"), listenScrollCaptureHud: subscribe("hud"),
      listenScrollCaptureDone: subscribe("done"), screenshotUiReady: async id => { calls.push(`show:${id}`); return true; },
    },
  });
  const received = [];
  const started = startScreenshotLifecycle({
    refreshConfig: async () => { calls.push("config"); },
    loadScreenshot: async () => { calls.push("load"); return 7; },
    clearScreenshot: () => calls.push("clear"), applyScrollStartMode: async () => calls.push("mode"),
    onScrollProgress: value => received.push(value), onScrollHud: value => received.push(value),
    onScrollDone: value => received.push(value),
  });
  await subscribed.promise;
  assert.equal(calls.includes("load"), false);
  subscribing.resolve(); await started;
  assert.deepEqual(calls, ["listen:refresh", "listen:clear", "listen:progress", "listen:hud", "listen:done", "config", "load", "show:7", "mode"]);
  const progress = { stage: "capturing" }, hud = { hidden: true, glow: true }, done = { ok: true };
  handlers.progress(progress); handlers.hud(hud); handlers.done(done);
  assert.deepEqual(received, [progress, hud, done]);
  handlers.clear(); await handlers.refresh();
  assert.deepEqual(calls.slice(-5), ["clear", "config", "load", "show:7", "mode"]);
});

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

function setupLoader(data, loadScreenshotScreens = async () => [], overrides = {}, waitViewport = async () => true) {
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
      if (name === "./viewport-ready") return { waitForScreenshotViewport: waitViewport };
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
  assert.deepEqual(calls, ["reset", "bounds", "screens", "cursor", "restore", "render"]);
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

test("a delayed multi-monitor viewport stays hidden until both native and CSS geometry are ready", async () => {
  const sized = deferred();
  const started = deferred();
  const { controller, calls, classes } = setupLoader(screenshotData, async () => [], {}, async ({ isCurrent }) => {
    started.resolve();
    await sized.promise;
    return isCurrent();
  });
  const loading = controller.load();
  await started.promise;
  assert.equal(classes.has("ready"), false);
  assert.deepEqual(calls, []);
  sized.resolve();
  assert.equal(await loading, 1);
  assert.equal(classes.has("ready"), true);
});

test("closing during viewport alignment prevents a late ready or session reset", async () => {
  const sized = deferred();
  const started = deferred();
  const { controller, calls, classes } = setupLoader(screenshotData, async () => [], {}, async ({ isCurrent }) => {
    started.resolve();
    await sized.promise;
    return isCurrent();
  });
  const loading = controller.load();
  await started.promise;
  controller.cancel();
  sized.resolve();
  assert.equal(await loading, null);
  assert.deepEqual(calls, []);
  assert.equal(classes.has("ready"), false);
});

test("a permanently squeezed viewport closes its capture instead of showing a distorted desktop", async () => {
  const { controller, calls, classes } = setupLoader(screenshotData, async () => [], {}, async () => {
    throw new Error("Screenshot viewport did not match the captured desktop");
  });
  assert.equal(await controller.load(), null);
  assert.deepEqual(calls, ["close"]);
  assert.equal(classes.has("ready"), false);
});

test("viewport is checked again after asynchronous initialization before marking the screenshot ready", async () => {
  let validations = 0;
  const { controller, calls, classes } = setupLoader(screenshotData, async () => [], {}, async () => ++validations === 1);
  assert.equal(await controller.load(), null);
  assert.equal(validations, 2);
  assert.equal(classes.has("ready"), false);
  assert.equal(calls.at(-1), "close");
});

test("late resize hides the screenshot while repairing and coalesces repeated notifications without losing edits", async () => {
  const sized = deferred(); let validations = 0;
  const { controller, calls, classes } = setupLoader(screenshotData, async () => [], {}, async () => {
    if (++validations <= 2) return true;
    return sized.promise;
  });
  await controller.load();
  assert.equal(classes.has("ready"), true);
  const first = controller.revalidate(), second = controller.revalidate();
  assert.equal(first, second);
  assert.equal(classes.has("ready"), false);
  sized.resolve(true); assert.equal(await first, true);
  assert.equal(classes.has("ready"), true);
  assert.equal(calls.filter(call => call === "reset").length, 1);
  assert.equal(calls.filter(call => call === "render").length, 2);
});

test("a display layout invalidated after showing closes only that screenshot", async () => {
  let validations = 0;
  const { controller, calls, classes } = setupLoader(screenshotData, async () => [], {}, async () => ++validations <= 2);
  await controller.load();
  assert.equal(await controller.revalidate(), false);
  assert.equal(classes.has("ready"), false);
  assert.equal(calls.at(-1), "close");
});

test("cancelling a resize repair cannot restore an obsolete ready state or close another capture", async () => {
  const sized = deferred(); let validations = 0;
  const { controller, calls, classes } = setupLoader(screenshotData, async () => [], {}, async () => {
    if (++validations <= 2) return true;
    return sized.promise;
  });
  await controller.load();
  const repairing = controller.revalidate();
  controller.cancel(); sized.resolve(true);
  assert.equal(await repairing, false);
  assert.equal(classes.has("ready"), false);
  assert.equal(calls.includes("close"), false);
  assert.equal(await controller.revalidate(), false);
});

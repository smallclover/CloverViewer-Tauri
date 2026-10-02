const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");
const {
  createUpdateController,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
} = require("../../.unit-test-dist/ui/update-controller.js");

const root = resolve(__dirname, "../..");
const settingsSource = readFileSync(resolve(root, "src/ui/settings-controller.ts"), "utf8");
const pageSource = readFileSync(resolve(root, "index.html"), "utf8");

test("updates are checked only from the explicit settings action", () => {
  assert.match(
    settingsSource,
    /checkUpdateButton\.addEventListener\("click", \(\) => void checkForUpdate\(\)\)/,
  );
  assert.doesNotMatch(settingsSource, /setTimeout\(\(\) => void checkForUpdate/);
});

test("update dialog provides release notes and a non-installing later choice", () => {
  assert.match(pageSource, /id="update-overlay"/);
  assert.match(pageSource, /id="update-notes"/);
  assert.match(pageSource, /id="update-later"/);
  assert.match(pageSource, /id="update-now"/);
  assert.match(settingsSource, /updateLater\.addEventListener\("click", \(\) => dismissUpdate\(false\)\)/);
  assert.match(settingsSource, /updateNow\.addEventListener\("click", \(\) => dismissUpdate\(true\)\)/);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup(overrides = {}, updateOverrides = {}) {
  const states = [];
  const calls = [];
  const update = {
    version: "0.2.0", body: "Release notes",
    download: async (receive, options) => {
      calls.push(["download", options.timeout]);
      receive({ event: "Started", data: { contentLength: 100 } });
      receive({ event: "Progress", data: { chunkLength: 100 } });
      receive({ event: "Finished" });
    },
    install: async () => { calls.push(["install"]); },
    close: async () => { calls.push(["close"]); },
    ...updateOverrides,
  };
  const controller = createUpdateController({
    check: async timeout => { calls.push(["check", timeout]); return update; },
    confirm: async found => { assert.equal(found, update); calls.push(["confirm"]); return true; },
    onState: state => states.push({ ...state }),
    yieldUi: async () => { calls.push(["paint"]); },
    wait: async delay => { calls.push(["wait", delay]); },
    ...overrides,
  });
  return { controller, states, calls, update };
}

test("checking feedback appears immediately, paints before the request and prevents concurrent checks", async () => {
  const painted = deferred();
  const checked = deferred();
  let checks = 0;
  const { controller, states } = setup({
    yieldUi: () => painted.promise,
    check: async timeout => { checks++; assert.equal(timeout, UPDATE_CHECK_TIMEOUT_MS); return checked.promise; },
  });
  const running = controller.run();
  assert.equal(states[0].phase, "checking");
  assert.equal(controller.isBusy(), true);
  assert.equal(checks, 0);
  controller.dismiss();
  await controller.run();
  assert.equal(controller.getState().phase, "checking");
  painted.resolve();
  await Promise.resolve();
  assert.equal(checks, 1);
  checked.resolve(null);
  await running;
  assert.equal(controller.getState().phase, "latest");
  assert.equal(controller.isBusy(), false);
  controller.dismiss();
  assert.equal(controller.getState().phase, "idle");
});

test("choosing later releases the native update resource without downloading or installing", async () => {
  const { controller, calls } = setup({ confirm: async () => false });
  await controller.run();
  assert.equal(controller.getState().phase, "idle");
  assert.deepEqual(calls, [["paint"], ["check", UPDATE_CHECK_TIMEOUT_MS], ["close"]]);
});

test("verified download uses a separate long timeout and completes before installation", async () => {
  const verified = deferred();
  const reachedVerification = deferred();
  const { controller, states, calls } = setup({}, {
    download: async (receive, options) => {
      assert.equal(options.timeout, UPDATE_DOWNLOAD_TIMEOUT_MS);
      assert.ok(options.timeout > UPDATE_CHECK_TIMEOUT_MS * 10);
      receive({ event: "Started", data: { contentLength: 100 } });
      receive({ event: "Progress", data: { chunkLength: 50 } });
      receive({ event: "Finished" });
      reachedVerification.resolve();
      await verified.promise;
    },
  });
  const running = controller.run();
  await reachedVerification.promise;
  assert.equal(controller.getState().phase, "verifying");
  assert.equal(calls.some(([name]) => name === "install"), false);
  assert.ok(states.some(state => state.phase === "downloading" && state.percent === 50));
  verified.resolve();
  await running;
  assert.equal(controller.getState().phase, "installed");
  assert.deepEqual(calls.slice(-3), [["paint"], ["install"], ["close"]]);
});

test("response-body failures retry from zero and ignore callbacks from the failed attempt", async t => {
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  let previousReceive;
  const { controller, states, calls } = setup({}, {
    download: async (receive, options) => {
      assert.equal(options.timeout, UPDATE_DOWNLOAD_TIMEOUT_MS);
      attempts++;
      receive({ event: "Started", data: { contentLength: 100 } });
      if (attempts === 1) {
        previousReceive = receive;
        receive({ event: "Progress", data: { chunkLength: 50 } });
        throw new Error("error decoding response body");
      }
      previousReceive({ event: "Progress", data: { chunkLength: 40 } });
      receive({ event: "Progress", data: { chunkLength: 25 } });
      receive({ event: "Finished" });
    },
  });
  await controller.run();
  assert.equal(attempts, 2);
  assert.ok(states.some(state => state.phase === "retrying" && state.attempt === 2));
  assert.ok(states.some(state => state.phase === "downloading" && state.attempt === 2 && state.downloaded === 0));
  assert.ok(states.some(state => state.phase === "downloading" && state.attempt === 2 && state.percent === 25));
  assert.equal(states.some(state => state.percent === 90), false);
  assert.equal(calls.filter(([name]) => name === "install").length, 1);
  assert.ok(calls.some(([name, delay]) => name === "wait" && delay === 1000));
});

test("downloads without Content-Length report received bytes instead of a false zero percent", async () => {
  const { controller, states } = setup({}, {
    download: async receive => {
      receive({ event: "Started", data: {} });
      receive({ event: "Progress", data: { chunkLength: 65536 } });
      receive({ event: "Finished" });
    },
  });
  await controller.run();
  assert.ok(states.some(state => state.phase === "downloading" && state.downloaded === 65536 && state.percent === undefined));
});

test("exhausted download retries keep the failure visible and allow a fresh user-triggered retry", async t => {
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  let failure = true;
  const { controller, calls } = setup({}, {
    download: async () => { attempts++; if (failure) throw new Error("request timed out while reading response body"); },
  });
  await controller.run();
  assert.equal(attempts, 3);
  assert.deepEqual(calls.filter(([name]) => name === "wait"), [["wait", 1000], ["wait", 2000]]);
  assert.equal(controller.getState().phase, "error");
  assert.equal(controller.getState().errorStage, "downloading");
  assert.equal(controller.getState().networkError, true);
  assert.match(controller.getState().error, /response body/);
  assert.equal(controller.isBusy(), false);
  assert.equal(calls.some(([name]) => name === "install"), false);
  failure = false;
  await controller.run();
  assert.equal(controller.getState().phase, "installed");
  assert.equal(calls.filter(([name]) => name === "check").length, 2);
  assert.equal(calls.filter(([name]) => name === "close").length, 2);
});

test("signature failures are never retried and cannot reach installation", async t => {
  t.mock.method(console, "warn", () => {});
  let downloads = 0;
  const { controller, calls } = setup({}, {
    download: async receive => {
      downloads++;
      receive({ event: "Finished" });
      throw new Error("signature verification failed for downloaded response body");
    },
  });
  await controller.run();
  assert.equal(downloads, 1);
  assert.equal(controller.getState().errorStage, "downloading");
  assert.equal(controller.getState().networkError, false);
  assert.equal(calls.some(([name]) => name === "install" || name === "wait"), false);
});

test("installer failures are reported separately and never trigger automatic installation retries", async t => {
  t.mock.method(console, "warn", () => {});
  let installs = 0;
  const { controller, calls } = setup({}, {
    install: async () => { installs++; throw new Error("installer launch failed"); },
  });
  await controller.run();
  assert.equal(installs, 1);
  assert.equal(controller.getState().errorStage, "installing");
  assert.equal(calls.filter(([name]) => name === "download").length, 1);
  assert.equal(calls.some(([name]) => name === "wait"), false);
});

test("failed metadata checks retain feedback and release the button for another check", async t => {
  t.mock.method(console, "warn", () => {});
  let checks = 0;
  const { controller } = setup({
    check: async () => { if (++checks === 1) throw new Error("connection timed out"); return null; },
  });
  await controller.run();
  assert.equal(controller.getState().errorStage, "checking");
  assert.equal(controller.getState().networkError, true);
  assert.equal(controller.isBusy(), false);
  await controller.run();
  assert.equal(controller.getState().phase, "latest");
});

function setupStatusView() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set(["hidden"]);
      const attributes = new Map();
      nodes.set(id, {
        hidden: true,
        classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) },
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: name => attributes.delete(name),
        addEventListener: () => {},
      });
    }
    return nodes.get(id);
  };
  const exports = {};
  const source = readFileSync(resolve(root, "src/ui/update-status-view.ts"), "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports,
    require: name => {
      assert.equal(name, "../api");
      return { formatSize: bytes => `${bytes} bytes` };
    },
    document: { getElementById: node },
  });
  let busy = true;
  const view = exports.createUpdateStatusView({
    checkButton: node("check-update"), translate: (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`,
    isBusy: () => busy, onRetry: () => {}, onDismiss: () => {},
  });
  return { view, node, finish: () => { busy = false; } };
}

test("status panel keeps checking and download feedback visible and uses real progress values", () => {
  const { view, node } = setupStatusView();
  view.render({ phase: "checking" });
  assert.equal(node("update-status").classList.contains("hidden"), false);
  assert.equal(node("check-update").disabled, true);
  assert.equal(node("update-status-spinner").hidden, false);
  assert.match(node("update-status-message").textContent, /update.checking/);
  view.render({ phase: "downloading", percent: 50, downloaded: 500, total: 1000 });
  assert.equal(node("update-status").classList.contains("hidden"), false);
  assert.equal(node("update-progress").hidden, false);
  assert.equal(node("update-progress").value, 50);
  view.render({ phase: "downloading", downloaded: 65536 });
  assert.match(node("update-status-message").textContent, /update.downloadingUnknown/);
  assert.match(node("update-status-message").textContent, /65536 bytes/);
});

test("download failures stay visible with details and retry, and differ from installation failures", () => {
  const { view, node, finish } = setupStatusView();
  finish();
  view.render({ phase: "error", errorStage: "downloading", networkError: true, error: "response body timed out" });
  assert.equal(node("update-status").classList.contains("hidden"), false);
  assert.match(node("update-status-message").textContent, /update.downloadInterrupted/);
  assert.equal(node("update-error-details").hidden, false);
  assert.equal(node("update-error-message").textContent, "response body timed out");
  assert.equal(node("update-retry").hidden, false);
  assert.equal(node("update-retry").disabled, false);
  assert.equal(node("update-dismiss").hidden, false);
  view.render({ phase: "error", errorStage: "installing", error: "installer launch failed" });
  assert.match(node("update-status-message").textContent, /update.installFailed/);
  view.render({ phase: "idle" });
  assert.equal(node("update-status").classList.contains("hidden"), true);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");
const exportsGuard = {};
runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, "../../src/screenshot/viewport-ready.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: exportsGuard, require: () => ({}) });
const { waitForScreenshotViewport } = exportsGuard;
const data = { capture_id: 7, total_width: 3840, total_height: 1080 };

test("a double-screen capture cannot use a single-screen CSS viewport, even if the native window is aligned", async () => {
  let width = 1920;
  let reads = 0;
  let pauses = 0;
  await waitForScreenshotViewport({ data, isCurrent: () => true,
    root: { getBoundingClientRect: () => { reads++; return { width, height: 1080 }; } },
    sync: async id => { assert.equal(id, 7); return true; },
    pause: async () => { if (++pauses === 3) width = 3840; },
  });
  assert.equal(reads, 5);
  assert.equal(pauses, 3);
});

test("DPI and interface zoom may scale both viewport axes uniformly", async () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    let pauses = 0;
    assert.equal(await waitForScreenshotViewport({ data, isCurrent: () => true,
      root: { getBoundingClientRect: () => ({ width: 3840 / scale, height: 1080 / scale }) },
      sync: async () => true, pause: async () => pauses++,
    }), true);
    assert.equal(pauses, 0);
  }
});

test("matching CSS geometry still waits for native window and WebView bounds to finish aligning", async () => {
  let nativeCalls = 0;
  assert.equal(await waitForScreenshotViewport({ data, isCurrent: () => true,
    root: { getBoundingClientRect: () => ({ width: 3840, height: 1080 }) },
    sync: async () => ++nativeCalls >= 3, pause: async () => {},
  }), true);
  assert.equal(nativeCalls, 4);
});

test("expired and cancelled sessions stop without displaying or repairing a newer capture", async () => {
  let calls = 0;
  const options = { data, root: {}, sync: async () => { calls++; return null; }, pause: async () => {} };
  assert.equal(await waitForScreenshotViewport({ ...options, isCurrent: () => false }), false);
  assert.equal(calls, 0);
  assert.equal(await waitForScreenshotViewport({ ...options, isCurrent: () => true }), false);
  assert.equal(calls, 1);
});

test("persistent distortion has a bounded failure instead of an infinite wait", async () => {
  let calls = 0;
  await assert.rejects(waitForScreenshotViewport({ data, isCurrent: () => true,
    root: { getBoundingClientRect: () => ({ width: 1920, height: 1080 }) },
    sync: async () => { calls++; return true; }, pause: async () => {},
  }), /viewport did not match/);
  assert.equal(calls, 30);
});

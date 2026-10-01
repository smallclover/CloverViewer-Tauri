const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

function setup(frames) {
  const exports = {};
  const requests = [];
  const canvases = [];
  const source = readFileSync(resolve(__dirname, "../../src/screenshot/screenshot-loader.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, {
    exports,
    require: () => ({ getScreenshotFrame: async (captureId, index) => {
      requests.push([captureId, index]);
      if (frames[index] instanceof Error) throw frames[index];
      return frames[index];
    } }),
    ImageData: class { constructor(pixels, width, height) { this.data = pixels; this.width = width; this.height = height; } },
    document: { createElement: (tag) => {
      assert.equal(tag, "canvas");
      const canvas = { width: 0, height: 0, getContext: () => ({ putImageData: data => { canvas.pixels = Array.from(data.data); } }) };
      canvases.push(canvas);
      return canvas;
    } },
  });
  return { ...exports, requests, canvases };
}

const screenshot = { capture_id: 7, min_x: -2, min_y: -1, screens: [
  { x: -2, y: -1, width: 2, height: 1 },
  { x: 0, y: 0, width: 1, height: 2 },
] };

test("binary RGBA frames preserve channel order, rows and negative-monitor coordinates", async () => {
  const rgba = [255, 0, 0, 255, 0, 37, 255, 255];
  const { loadScreenshotScreens, requests } = setup([Uint8Array.from(rgba).buffer, Uint8Array.from(rgba).buffer]);
  const screens = await loadScreenshotScreens(screenshot);
  assert.deepEqual(requests, [[7, 0], [7, 1]]);
  assert.deepEqual(screens[0].img.pixels, rgba);
  assert.deepEqual(screens[1].img.pixels, rgba);
  assert.equal(screens[0].x, 0);
  assert.equal(screens[0].y, 0);
  assert.equal(screens[1].x, 2);
  assert.equal(screens[1].y, 1);
});

test("the IPC fallback byte array produces the same pixels", async () => {
  const rgba = [255, 0, 0, 255, 0, 37, 255, 255];
  const { loadScreenshotScreens } = setup([rgba, rgba]);
  const screens = await loadScreenshotScreens(screenshot);
  assert.deepEqual(screens[0].img.pixels, rgba);
});

test("a truncated frame rejects the whole screenshot and releases other display canvases", async () => {
  const { loadScreenshotScreens, canvases } = setup([new ArrayBuffer(4), new ArrayBuffer(8)]);
  await assert.rejects(loadScreenshotScreens(screenshot), /Invalid screenshot RGBA frame size/);
  assert.equal(canvases.length, 1);
  assert.equal(canvases[0].width, 0);
  assert.equal(canvases[0].height, 0);
});

test("an expired frame request cannot produce a partially blank screenshot", async () => {
  const { loadScreenshotScreens, canvases } = setup([new ArrayBuffer(8), new Error("Screenshot session has expired")]);
  await assert.rejects(loadScreenshotScreens(screenshot), /session has expired/);
  assert.equal(canvases[0].width, 0);
});

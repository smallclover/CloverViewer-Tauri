const assert = require("node:assert/strict");
const test = require("node:test");
const { fitCropViewport, createCropViewport } = require("../../.unit-test-dist/image-editor/crop-viewport.js");

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8);

test("cropping fits and centers an off-center selection while keeping source pixel coordinates", () => {
  const image = { w: 4000, h: 3000 };
  const viewport = { w: 900, h: 600 };
  const selection = { x: 2300, y: 1600, w: 1000, h: 800 };
  const full = fitCropViewport(image, { x: 0, y: 0, ...image }, viewport);
  const fitted = fitCropViewport(image, selection, viewport);
  assert.ok(fitted.scale > full.scale);
  near(fitted.left + (selection.x + selection.w / 2) * fitted.scale, viewport.w / 2);
  near(fitted.top + (selection.y + selection.h / 2) * fitted.scale, viewport.h / 2);
  assert.ok(selection.w * fitted.scale <= viewport.w - 24);
  assert.ok(selection.h * fitted.scale <= viewport.h - 24);
  const point = { x: 2700, y: 1850 };
  near((fitted.left + point.x * fitted.scale - fitted.left) / fitted.scale, point.x);
  near((fitted.top + point.y * fitted.scale - fitted.top) / fitted.scale, point.y);
  assert.deepEqual(selection, { x: 2300, y: 1600, w: 1000, h: 800 });
});

test("portrait crops, original-sized small images and hidden workspaces fit safely", () => {
  const portrait = fitCropViewport({ w: 3000, h: 4000 }, { x: 1200, y: 1500, w: 100, h: 2000 }, { w: 600, h: 500 });
  near(portrait.scale, 476 / 2000);
  const small = fitCropViewport({ w: 100, h: 80 }, { x: 10, y: 20, w: 30, h: 20 }, { w: 600, h: 500 });
  assert.equal(small.scale, 1);
  assert.equal(fitCropViewport({ w: 100, h: 80 }, { x: 0, y: 0, w: 0, h: 20 }, { w: 600, h: 500 }), null);
  assert.equal(fitCropViewport({ w: 100, h: 80 }, { x: 0, y: 0, w: 100, h: 80 }, { w: 0, h: 0 }), null);
});

test("crop dragging keeps the viewport stable until release, then tool switching clips only the crop", () => {
  const originalObserver = global.ResizeObserver;
  let resize;
  global.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} };
  try {
    let crop = null;
    let cropping = true;
    let layouts = 0;
    const canvas = { width: 4000, height: 3000, style: {} };
    const surface = { clientWidth: 900, clientHeight: 600 };
    const viewport = createCropViewport({ canvas, surface, getCrop: () => crop, isCropping: () => cropping, onLayout: () => layouts++ });
    viewport.fit();
    const original = { ...canvas.style };
    viewport.begin();
    crop = { x: 2400, y: 1600, w: 800, h: 600 };
    viewport.fit();
    resize();
    assert.deepEqual(canvas.style, original);
    assert.equal(layouts, 1);
    viewport.end();
    assert.ok(parseFloat(canvas.style.width) > parseFloat(original.width));
    near(parseFloat(canvas.style.left) + 2800 * parseFloat(canvas.style.width) / canvas.width, 450);
    cropping = false;
    viewport.fit();
    assert.equal(canvas.style.clipPath, "inset(53.333333333333336% 20% 26.666666666666668% 60%)");
    cropping = true;
    viewport.fit();
    assert.equal(canvas.style.clipPath, "");
    surface.clientWidth = 500;
    resize();
    near(parseFloat(canvas.style.left) + 2800 * parseFloat(canvas.style.width) / canvas.width, 250);
    crop = null;
    viewport.fit();
    assert.equal(canvas.style.clipPath, "");
    assert.ok(parseFloat(canvas.style.width) <= surface.clientWidth - 24);
  } finally { global.ResizeObserver = originalObserver; }
});

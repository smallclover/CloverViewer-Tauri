const assert = require("node:assert/strict");
const test = require("node:test");
const { fitCropViewport, createCropViewport } = require("../../.unit-test-dist/image-editor/crop-viewport.js");

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8);

function withAnimatedViewport(run, reducedMotion = false, fixedCrop = false) {
  const originals = Object.fromEntries(["ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia"].map(key => [key, global[key]]));
  let resize, id = 0, crop = null, cropping = true;
  const frames = new Map();
  const layouts = [];
  global.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} };
  global.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  global.cancelAnimationFrame = frame => frames.delete(frame);
  global.matchMedia = () => ({ matches: reducedMotion });
  const canvas = { width: 4000, height: 3000, style: {} };
  const surface = { clientWidth: 900, clientHeight: 600 };
  const viewport = createCropViewport({ canvas, surface, getCrop: () => crop, isCropping: () => cropping, onCropChange: fixedCrop ? value => { crop = value; } : undefined, onLayout: animating => layouts.push({ animating, style: { ...canvas.style } }) });
  const tick = time => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(time));
  };
  try {
    run({ canvas, surface, viewport, frames, layouts, tick, resize: () => resize(), crop: value => { crop = value; }, getCrop: () => crop, setCropping: value => { cropping = value; } });
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  }
}

test("crop zoom and image panning keep the screen frame fixed and clamp before revealing blank pixels", () => {
  withAnimatedViewport(({canvas, viewport, crop, getCrop}) => {
    crop({x:1200,y:900,w:1600,h:1200}); viewport.fit();
    const frame = () => {
      const selection = getCrop(), scale = viewport.scale();
      return {x:parseFloat(canvas.style.left)+selection.x*scale,y:parseFloat(canvas.style.top)+selection.y*scale,w:selection.w*scale,h:selection.h*scale};
    };
    const original = frame();
    const fixed = () => { const current = frame(); for (const key of ["x","y","w","h"]) near(current[key],original[key]); };
    viewport.zoomBy(2,{x:350,y:200}); fixed();
    near(getCrop().w,800); near(getCrop().h,600);
    viewport.panBy(70,-40); fixed();
    viewport.panBy(1000000,-1000000); fixed();
    assert(getCrop().x >= 0 && getCrop().y >= 0);
    assert(getCrop().x+getCrop().w <= canvas.width+1e-7);
    assert(getCrop().y+getCrop().h <= canvas.height+1e-7);
    viewport.zoomBy(0.000001); fixed();
    near(viewport.scale(), Math.max(original.w/canvas.width,original.h/canvas.height));
    const saved = {...getCrop()}; viewport.zoomBy(0.1); fixed();
    assert.deepEqual(getCrop(),saved);
  }, false, true);
});

test("fixed-frame zoom starts from the full image and leaves annotation views and explicit resets unchanged", () => {
  withAnimatedViewport(({canvas, viewport, crop, getCrop, setCropping}) => {
    viewport.fit();
    const scale = viewport.scale(); viewport.zoomBy(2);
    assert(getCrop()); near(getCrop().w,canvas.width/2); near(getCrop().h,canvas.height/2);
    const selection = {...getCrop()};
    setCropping(false); viewport.zoomBy(2);
    assert.deepEqual(getCrop(),selection); near(viewport.scale(),scale*4);
    setCropping(true); viewport.actualSize();
    assert.equal(viewport.scale(),1); assert.deepEqual(getCrop(),selection);
    viewport.fit(); assert.deepEqual(getCrop(),selection);
    crop({x:10,y:10,w:4,h:4}); viewport.fit(); viewport.zoomBy(1000);
    near(getCrop().w,2); near(getCrop().h,2);
  }, false, true);
});

test("manual zoom preserves the cursor image point, pans in CSS pixels, and survives tool refresh", () => {
  withAnimatedViewport(({canvas,viewport}) => {
    viewport.fit();
    const before = {left:parseFloat(canvas.style.left),top:parseFloat(canvas.style.top),scale:viewport.scale()};
    const anchor={x:150,y:250}; const pixel={x:(anchor.x-before.left)/before.scale,y:(anchor.y-before.top)/before.scale};
    viewport.zoomBy(2,anchor);
    near(parseFloat(canvas.style.left)+pixel.x*viewport.scale(),anchor.x);
    near(parseFloat(canvas.style.top)+pixel.y*viewport.scale(),anchor.y);
    const manual={...canvas.style}; viewport.refresh(); assert.deepEqual(canvas.style,manual);
    viewport.panBy(60,-50); near(parseFloat(canvas.style.left),parseFloat(manual.left)+60);
    viewport.actualSize(); assert.equal(viewport.scale(),1);
    viewport.zoomBy(1000); assert.equal(viewport.scale(),40);
    viewport.zoomBy(0.00001); assert.equal(viewport.scale(),0.05);
    const locked={...canvas.style}; viewport.begin(); viewport.zoomBy(2);viewport.panBy(100,100);
    assert.deepEqual(canvas.style,locked); viewport.end(true);
    viewport.fit(); near(viewport.scale(),before.scale);
  });
});

test("crop release smoothly moves and scales the viewport while synchronizing overlay layout", () => {
  withAnimatedViewport(({ canvas, viewport, crop, tick, frames, layouts }) => {
    viewport.fit();
    const original = { ...canvas.style };
    const selection = { x: 2400, y: 1600, w: 800, h: 600 };
    viewport.begin();
    crop(selection);
    viewport.end();
    assert.deepEqual(canvas.style, original, "release must not jump to the final position");
    tick(10);
    tick(120);
    const fitted = fitCropViewport({ w: 4000, h: 3000 }, selection, { w: 900, h: 600 });
    assert(parseFloat(canvas.style.width) > parseFloat(original.width));
    assert(parseFloat(canvas.style.width) < fitted.width);
    assert.equal(layouts.at(-1).animating, true);
    tick(230);
    near(parseFloat(canvas.style.left) + 2800 * fitted.scale, 450);
    near(parseFloat(canvas.style.top) + 1900 * fitted.scale, 300);
    assert.equal(layouts.at(-1).animating, false);
    assert.equal(frames.size, 0);
    assert.deepEqual(selection, { x: 2400, y: 1600, w: 800, h: 600 });
  });
});

test("starting another crop interrupts centering at the visible position and ignores stale frames", () => {
  withAnimatedViewport(({ canvas, viewport, crop, tick, frames }) => {
    viewport.fit();
    viewport.begin();
    crop({ x: 2400, y: 1600, w: 800, h: 600 });
    viewport.end();
    tick(0);
    tick(70);
    const current = { ...canvas.style };
    const staleFrame = [...frames.values()][0];
    viewport.begin();
    assert.equal(frames.size, 0);
    staleFrame(300);
    crop({ x: 2200, y: 1500, w: 1000, h: 700 });
    viewport.fit();
    assert.deepEqual(canvas.style, current);
    viewport.end();
    assert.deepEqual(canvas.style, current);
    tick(400);
    tick(620);
    const scale = parseFloat(canvas.style.width) / canvas.width;
    near(parseFloat(canvas.style.left) + 2700 * scale, 450);
    near(parseFloat(canvas.style.top) + 1850 * scale, 300);
  });
});

test("resizing during centering cancels motion and fits the new viewport immediately", () => {
  withAnimatedViewport(({ canvas, surface, viewport, crop, tick, frames, resize }) => {
    viewport.fit();
    viewport.begin();
    crop({ x: 2400, y: 1600, w: 800, h: 600 });
    viewport.end();
    tick(0);
    tick(50);
    surface.clientWidth = 500;
    resize();
    assert.equal(frames.size, 0);
    const scale = parseFloat(canvas.style.width) / canvas.width;
    near(parseFloat(canvas.style.left) + 2800 * scale, 250);
  });
});

test("reduced motion and cancelled drags center immediately without animation", () => {
  for (const reducedMotion of [false, true]) {
    withAnimatedViewport(({ canvas, viewport, crop, frames }) => {
      viewport.fit();
      viewport.begin();
      crop({ x: 2400, y: 1600, w: 800, h: 600 });
      viewport.end(!reducedMotion);
      assert.equal(frames.size, 0);
      const scale = parseFloat(canvas.style.width) / canvas.width;
      near(parseFloat(canvas.style.left) + 2800 * scale, 450);
    }, reducedMotion);
  }
});

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

test("portrait crops, enlarged small images and hidden workspaces fit safely", () => {
  const portrait = fitCropViewport({ w: 3000, h: 4000 }, { x: 1200, y: 1500, w: 100, h: 2000 }, { w: 600, h: 500 });
  near(portrait.scale, 476 / 2000);
  const small = fitCropViewport({ w: 100, h: 80 }, { x: 10, y: 20, w: 30, h: 20 }, { w: 600, h: 500 });
  assert.equal(small.scale, 2);
  near(small.left + 25 * small.scale, 300);
  near(small.top + 30 * small.scale, 250);
  const constrained = fitCropViewport({ w: 400, h: 300 }, { x: 0, y: 0, w: 400, h: 300 }, { w: 600, h: 500 });
  near(constrained.scale, 576 / 400);
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

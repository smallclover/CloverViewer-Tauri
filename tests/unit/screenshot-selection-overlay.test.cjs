const assert = require("node:assert/strict");
const test = require("node:test");
const { createSelectionOverlay } = require("../../.unit-test-dist/screenshot/selection-overlay.js");

function setup(scale = 2) {
  let writes = 0;
  let width = 3840 / scale;
  let height = 2160 / scale;
  const elements = [];
  const createElement = () => {
    const element = { children: [], hidden: false, textContent: "", style: new Proxy({}, {
      set(target, key, value) { writes++; target[key] = value; return true; },
    }), append(...nodes) { this.children.push(...nodes); } };
    elements.push(element);
    return element;
  };
  const previousDocument = global.document;
  global.document = { createElement };
  try {
    const canvas = { width: 3840, height: 2160, style: {} };
    const overlay = createSelectionOverlay({ root: createElement(), canvas, getViewport: () => ({ width, height }) });
    return { overlay, canvas, writes: () => writes, resize: () => { width = 960; height = 540; },
      masks: elements.filter(el => el.className === "screenshot-selection-mask"),
      frame: elements.find(el => el.className === "screenshot-selection-frame"),
      label: elements.find(el => el.className === "screenshot-selection-label"),
    };
  } finally { global.document = previousDocument; }
}

test("selection mask uses CSS geometry while the size label keeps original pixels", () => {
  const f = setup();
  const selection = { x: 400, y: 200, w: 1000, h: 800 };
  f.overlay.update(selection, null);
  assert.equal(f.frame.style.transform, "translate(200px, 100px)");
  assert.equal(f.frame.style.width, "500px");
  assert.equal(f.frame.style.height, "400px");
  assert.equal(f.label.textContent, "1000x800");
  assert.deepEqual(f.masks.map(mask => [mask.style.left, mask.style.top, mask.style.width, mask.style.height]), [
    ["0px", "0px", "1920px", "100px"],
    ["0px", "500px", "1920px", "580px"],
    ["0px", "100px", "200px", "400px"],
    ["700px", "100px", "1220px", "400px"],
  ]);
  assert.ok(f.masks.every(mask => !mask.hidden));
  const writes = f.writes();
  for (let frame = 0; frame < 100; frame++) f.overlay.update(selection, null);
  assert.equal(f.writes(), writes);
  f.resize();
  f.overlay.update(selection, null);
  assert.equal(f.frame.style.transform, "translate(100px, 50px)");
  assert.equal(f.label.textContent, "1000x800");
});

test("fractional DPI masks cover only the outside, with no overlap or magnified 1px geometry", () => {
  for (const scale of [1, 1.25, 1.5, 1.65, 1.875, 2]) {
    const f = setup(scale);
    const rect = { x: 431, y: 187, w: 948, h: 681 };
    f.overlay.update(rect, null);
    const masks = f.masks.map(mask => {
      assert.equal(mask.style.transform, undefined);
      return { x: parseFloat(mask.style.left) * scale, y: parseFloat(mask.style.top) * scale,
        w: parseFloat(mask.style.width) * scale, h: parseFloat(mask.style.height) * scale };
    });
    const epsilon = 1e-8;
    for (const mask of masks) {
      assert.ok(mask.w >= 0 && mask.h >= 0);
      const overlapW = Math.min(mask.x + mask.w, rect.x + rect.w) - Math.max(mask.x, rect.x);
      const overlapH = Math.min(mask.y + mask.h, rect.y + rect.h) - Math.max(mask.y, rect.y);
      assert.ok(overlapW <= epsilon || overlapH <= epsilon);
    }
    assert.ok(Math.abs(masks.reduce((area, mask) => area + mask.w * mask.h, 0) -
      (3840 * 2160 - rect.w * rect.h)) < epsilon);
  }
});

test("window hover has a frame without dimming, and reset restores the full input plane", () => {
  const f = setup();
  const rect = { x: 100, y: 100, w: 500, h: 400 };
  f.overlay.update(null, rect);
  assert.equal(f.overlay.element.hidden, false);
  assert.ok(f.masks.every(mask => mask.hidden));
  assert.equal(f.canvas.style.clipPath, "");
  f.overlay.update(rect, null);
  assert.ok(f.canvas.style.clipPath.startsWith("inset("));
  f.overlay.hide();
  assert.equal(f.overlay.element.hidden, true);
  assert.equal(f.canvas.style.clipPath, "");
  f.overlay.update(rect, null);
  assert.equal(f.overlay.element.hidden, false);
  f.overlay.update(null, null);
  assert.equal(f.overlay.element.hidden, true);
});

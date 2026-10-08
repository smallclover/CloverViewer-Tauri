const assert = require("node:assert/strict");
const test = require("node:test");
const { createSelectionOverlay } = require("../../.unit-test-dist/screenshot/selection-overlay.js");

function setup() {
  let writes = 0;
  let width = 1920;
  let height = 1080;
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
  assert.deepEqual(f.masks.map(mask => mask.style.transform), [
    "translate(0px, 0px) scale(1920, 100)",
    "translate(0px, 500px) scale(1920, 580)",
    "translate(0px, 100px) scale(200, 400)",
    "translate(700px, 100px) scale(1220, 400)",
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

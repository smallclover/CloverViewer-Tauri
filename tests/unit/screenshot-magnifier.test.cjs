const test = require("node:test");
const assert = require("node:assert/strict");
const { centerColorHex } = require("../../.unit-test-dist/compiled/screenshot/magnifier.js");
const { createMagnifierRenderer } = require("../../.unit-test-dist/compiled/screenshot/magnifier.js");
const { createMagnifierVisibility } = require("../../.unit-test-dist/compiled/screenshot/magnifier-visibility.js");

test("magnifier copies the center pixel as an uppercase hex color", () => {
  const pixels = new Uint8ClampedArray(3 * 3 * 4);
  const center = (1 * 3 + 1) * 4;
  pixels.set([10, 171, 255, 128], center);

  assert.equal(centerColorHex(pixels, 3), "#0AABFF");
});

test("magnifier caches integer pixel samples, invalidates new captures and scales the sample once", () => {
  const previousDocument = global.document;
  const canvases = [];
  let reads = 0;
  let image = {};
  let copiedAt = -Infinity;
  let scale = 2;
  let theme = "dark";
  const makeCanvas = () => {
    const canvas = { width: 0, height: 0 };
    const calls = [];
    const context = new Proxy({ canvas, calls, measureText: (text) => ({ width: text.length * 5 }),
      getImageData: () => {
        reads++;
        const data = new Uint8ClampedArray(15 * 15 * 4);
        for (let index = 0; index < data.length; index += 4) data.set([10, 171, 255, 255], index);
        return { data };
      },
    }, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]) });
    canvas.getContext = () => context;
    canvases.push(canvas);
    return canvas;
  };
  global.document = { createElement: makeCanvas };
  try {
    const magnifier = createMagnifierRenderer({ getScreens: () => [{ image, x: 0, y: 0, w: 1000, h: 1000 }],
      getViewport: () => ({ width: 500, height: 500 }), getScale: () => scale, getTheme: () => theme,
      translate: key => key, getCopyColorHotkey: () => "Alt+C", getCopiedAt: () => copiedAt,
    });
    const target = makeCanvas().getContext();
    magnifier.draw(target, 100.1, 100.1);
    assert.equal(reads, 1);
    assert.equal(target.calls.filter(([name]) => name === "fillRect").length, 2);
    assert.equal(target.calls.filter(([name]) => name === "drawImage").length, 1);
    assert.equal(target.imageSmoothingEnabled, false);
    assert.deepEqual(target.calls.find(([name]) => name === "translate"), ["translate", 140.1, 140.1]);
    assert.deepEqual(target.calls.find(([name]) => name === "scale"), ["scale", 2, 2]);
    assert.deepEqual(target.calls.find(([name]) => name === "drawImage").slice(1), [canvases[0], 0, 0, 15, 15, 4, 4, 120, 120]);
    assert.equal(target.fillStyle, "#69b77a");
    theme = "light";
    magnifier.draw(target, 100.1, 100.1);
    assert.equal(target.fillStyle, "#3d8a49");
    assert.equal(magnifier.colorAt(100.3, 100.3), "#0AABFF");
    assert.equal(reads, 1);
    copiedAt = performance.now();
    magnifier.draw(target, 100.3, 100.3);
    assert.ok(target.calls.some(([name, text]) => name === "fillText" && text === "shot.copied"));
    copiedAt = -Infinity;
    magnifier.draw(target, 100.3, 100.3);
    assert.equal(target.calls.filter(([name]) => name === "fillText").at(-2)[1], "#0AABFF");
    assert.equal(reads, 1, "copy feedback expires without another pixel read");
    magnifier.colorAt(100.8, 100.8);
    assert.equal(reads, 2);
    image = {};
    magnifier.colorAt(100.8, 100.8);
    assert.equal(reads, 3);
    for (scale of [1, 1.25, 1.5, 2, 2.5]) {
      for (const [x, y] of [[0, 0], [499 * scale, 499 * scale], [0, 499 * scale], [499 * scale, 0]]) {
        const box = magnifier.getBox(x, y);
        assert.equal(box.w, 128);
        assert.equal(box.h, 172);
        assert.ok(box.x >= 0 && box.x + box.w <= 500 && box.y >= 0 && box.y + box.h <= 500);
      }
    }
    magnifier.reset();
    assert.equal(canvases[0].width, 0);
    magnifier.colorAt(100.8, 100.8);
    assert.equal(reads, 4);
    assert.equal(canvases[0].width, 15);
  } finally { global.document = previousDocument; }
});

function visibilityFixture() {
  const previousWindow = global.window;
  const handlers = new Map();
  global.window = {
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: (name) => handlers.delete(name),
  };
  const state = { enabled: true, scrollIdle: true, textEditing: false, overUI: false,
    point: { x: 150, y: 150 }, selection: null, tool: null, dragMode: "none" };
  let changes = 0;
  const controller = createMagnifierVisibility({ getState: () => state, onChange: () => changes++ });
  return { state, controller, changes: () => changes,
    fire: (name, props = {}) => {
      let prevented = false;
      handlers.get(name)?.({ key: "Alt", preventDefault: () => { prevented = true; }, ...props });
      return prevented;
    },
    close: () => { controller.dispose(); global.window = previousWindow; },
  };
}

test("magnifier appears before and during selection, then stays hidden even at selection edges", () => {
  const f = visibilityFixture();
  try {
    assert.deepEqual(f.controller.getPoint(), f.state.point);
    f.state.selection = { x: 100, y: 100, w: 200, h: 200 };
    assert.equal(f.controller.getPoint(), null);
    for (const point of [{ x: 100, y: 150 }, { x: 300, y: 150 }, { x: 150, y: 100 }, { x: 150, y: 300 }, { x: 95, y: 95 }]) {
      f.state.point = point;
      assert.equal(f.controller.getPoint(), null, "passing an edge or corner must not summon the lens");
      f.fire("keydown");
      assert.deepEqual(f.controller.getPoint(), point, "Alt can still inspect an edge");
      f.fire("keyup");
      assert.equal(f.controller.getPoint(), null);
    }
    f.state.point = { x: 90, y: 150 };
    assert.equal(f.controller.getPoint(), null);
    for (const dragMode of ["move-selection", "move", "resize"]) {
      f.state.dragMode = dragMode;
      assert.equal(f.controller.getPoint(), null, "moving or resizing annotations must not summon the lens");
    }
    f.state.dragMode = "select";
    f.state.point = { x: 200, y: 200 };
    assert.deepEqual(f.controller.getPoint(), f.state.point);
    f.state.dragMode = "pending-win";
    assert.deepEqual(f.controller.getPoint(), f.state.point);
    f.state.dragMode = "none";
    assert.equal(f.controller.getPoint(), null, "releasing selection hides the lens immediately");
    f.state.selection = null;
    assert.deepEqual(f.controller.getPoint(), f.state.point, "reselecting restores automatic display");
    f.state.tool = "arrow";
    assert.equal(f.controller.getPoint(), null);
    f.state.tool = null;
    f.state.overUI = true;
    assert.equal(f.controller.getPoint(), null);
  } finally { f.close(); }
});

test("holding Alt temporarily summons the lens, without overriding text, UI, scrolling or disabled settings", () => {
  const f = visibilityFixture();
  try {
    f.state.selection = { x: 100, y: 100, w: 200, h: 200 };
    f.state.tool = "mosaic";
    assert.equal(f.controller.getPoint(), null);
    assert.equal(f.fire("keydown"), true);
    assert.deepEqual(f.controller.getPoint(), f.state.point);
    const changes = f.changes();
    f.fire("keydown");
    assert.equal(f.changes(), changes, "key repeat does not repaint");
    f.fire("keydown", { key: "c", altKey: true });
    assert.deepEqual(f.controller.getPoint(), f.state.point, "Alt+C still has a visible sampling point");
    for (const [key, value] of [["overUI", true], ["textEditing", true], ["scrollIdle", false], ["enabled", false]]) {
      const previous = f.state[key];
      f.state[key] = value;
      assert.equal(f.controller.getPoint(), null);
      f.state[key] = previous;
    }
    f.fire("keyup");
    assert.equal(f.controller.getPoint(), null);
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
      assert.equal(f.fire("keydown", modifiers), false);
      assert.equal(f.controller.getPoint(), null);
    }
    f.fire("keydown");
    f.fire("blur");
    assert.equal(f.controller.getPoint(), null);
    f.fire("focus");
    assert.equal(f.controller.getPoint(), null, "lost keyup cannot leave Alt latched after refocus");
    f.fire("keydown");
    f.controller.reset();
    assert.equal(f.controller.getPoint(), null, "a new screenshot clears temporary display");
  } finally { f.close(); }
});

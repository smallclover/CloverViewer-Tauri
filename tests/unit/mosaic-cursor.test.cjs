const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

function setup(initialScale = 0.2, initialSize = 80, trackPointer = true) {
  let scale = initialScale;
  let size = initialSize;
  let enabled = true;
  let selection = null;
  let hit;
  let ring;
  const surfaceEvents = {};
  const windowEvents = {};
  const layerEvents = {};
  const classes = new Set();
  let hitTests = 0;
  let layoutReads = 0;
  const surface = { width: 2000, height: 1000,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    getBoundingClientRect: () => { layoutReads++; return { left: 120, top: 80, width: 2000 * scale, height: 1000 * scale }; },
    addEventListener: (name, handler) => { surfaceEvents[name] = handler; },
  };
  hit = surface;
  const layer = { scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
    append: element => { ring = element; },
    addEventListener: (name, handler) => { layerEvents[name] = handler; },
  };
  const source = readFileSync(resolve(__dirname, "../../src/image-editor/mosaic-cursor.ts"), "utf8");
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, document: { createElement: () => ({ style: {} }), elementFromPoint: () => { hitTests++; return hit; } },
    window: { addEventListener: (name, handler) => { windowEvents[name] = handler; } },
    ResizeObserver: class { observe() {} },
  });
  const cursor = exports.createMosaicCursor({ surface, layer, getSize: () => size, trackPointer,
    isEnabled: point => enabled && (!selection ||
      (point.x >= selection.x && point.x <= selection.x + selection.w &&
       point.y >= selection.y && point.y <= selection.y + selection.h)),
  });
  return { cursor, ring, surface, layer, hitTests: () => hitTests, layoutReads: () => layoutReads,
    move: (x = 300, y = 160) => surfaceEvents.pointermove({ clientX: x, clientY: y }),
    leave: () => surfaceEvents.pointerleave(), cancel: () => surfaceEvents.pointercancel(),
    blur: () => windowEvents.blur(), resize: value => { scale = value; windowEvents.resize(); },
    scroll: (x, y) => { layer.scrollLeft = x; layer.scrollTop = y; layerEvents.scroll(); },
    setSize: value => { size = value; cursor.refresh(); },
    setEnabled: value => { enabled = value; cursor.refresh(); },
    setHit: value => { hit = value; }, setSelection: value => { selection = value; },
    nativeCursorHidden: () => classes.has("mosaic-cursor-active"),
  };
}

test("mosaic cursor matches the selected image-pixel block at fitted and screenshot scales", () => {
  for (const [scale, size] of [[0.2, 80], [0.5, 16], [1, 48]]) {
    const fixture = setup(scale, size);
    fixture.move(140, 100);
    assert.equal(fixture.ring.hidden, false);
    assert.equal(parseFloat(fixture.ring.style.width), size * scale);
    assert.equal(fixture.ring.style.width, fixture.ring.style.height);
    assert.equal(fixture.nativeCursorHidden(), true);
    fixture.setSize(size * 2);
    assert.equal(parseFloat(fixture.ring.style.width), size * 2 * scale);
  }
});

test("screenshot cursor uses the existing physical mouse coordinates without duplicate hit testing or per-move layout reads", () => {
  const fixture = setup(0.5, 16, false);
  fixture.setHit({});
  for (let index = 0; index < 500; index++) fixture.cursor.update({ x: 100 + index, y: 80 });
  assert.equal(fixture.ring.hidden, false);
  assert.equal(fixture.ring.style.width, "8px");
  assert.equal(fixture.ring.style.left, "319.5px");
  assert.equal(fixture.nativeCursorHidden(), true);
  assert.equal(fixture.hitTests(), 0);
  assert.equal(fixture.layoutReads(), 1);
  fixture.cursor.update(null);
  assert.equal(fixture.ring.hidden, true);
  assert.equal(fixture.nativeCursorHidden(), false);
});

test("cursor stays at the pointer while preview zoom and workspace scroll change", () => {
  const fixture = setup();
  fixture.move();
  assert.equal(fixture.ring.style.left, "200px");
  assert.equal(fixture.ring.style.top, "110px");
  fixture.resize(0.1);
  assert.equal(fixture.ring.style.width, "8px");
  fixture.scroll(30, 15);
  assert.equal(fixture.ring.style.left, "230px");
  assert.equal(fixture.ring.style.top, "125px");
  fixture.setSize(2000);
  assert.equal(fixture.ring.style.width, "200px", "large sizes are not limited by native cursor images");
});

test("controls, other tools, selection boundaries and off-canvas dragging restore the native cursor", () => {
  const fixture = setup();
  fixture.move();
  fixture.setEnabled(false);
  assert.equal(fixture.ring.hidden, true);
  assert.equal(fixture.nativeCursorHidden(), false);
  fixture.setEnabled(true);
  assert.equal(fixture.ring.hidden, false);
  fixture.setHit({}); fixture.move();
  assert.equal(fixture.ring.hidden, true);
  assert.equal(fixture.nativeCursorHidden(), false);
  fixture.setHit(fixture.surface);
  fixture.setSelection({ x: 0, y: 0, w: 500, h: 500 });
  fixture.move();
  assert.equal(fixture.ring.hidden, true);
  fixture.move(150, 100);
  assert.equal(fixture.ring.hidden, false);
  fixture.move(900, 600);
  assert.equal(fixture.ring.hidden, true);
  assert.equal(fixture.nativeCursorHidden(), false);
});

test("leaving, cancellation, losing focus and session reset cannot revive a stale circle", () => {
  const fixture = setup();
  for (const stop of [fixture.leave, fixture.cancel, fixture.blur, fixture.cursor.reset]) {
    fixture.move();
    assert.equal(fixture.ring.hidden, false);
    stop(); fixture.cursor.refresh();
    assert.equal(fixture.ring.hidden, true);
    assert.equal(fixture.nativeCursorHidden(), false);
  }
  fixture.move(); fixture.setSize(NaN);
  assert.equal(fixture.ring.hidden, true);
});

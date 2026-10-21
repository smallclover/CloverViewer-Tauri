const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const nodes = [], frames = new Map(), windowEvents = new Map(), ended = [];
  let serial = 0, before, crop = { x: 100, y: 100, w: 400, h: 300 };
  const node = () => {
    const handlers = new Map(), captures = new Set();
    const element = { style: {}, dataset: {}, classList: { toggle() {} },
      append() {}, setAttribute() {}, closest: () => null,
      addEventListener: (name, handler) => handlers.set(name, handler),
      fire: (name, event) => handlers.get(name)?.(event),
      setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
      releasePointerCapture: id => { captures.delete(id); element.fire("lostpointercapture", { pointerId: id }); },
    };
    nodes.push(element); return element;
  };
  const { createCropOverlay } = loadTs("image-editor/crop-overlay.ts", {
    "./crop-preview": { createCropPreview: () => ({ prepare() {}, clip() {}, invalidate() {} }) },
  }, {
    document: { createElement: node },
    window: { addEventListener: (name, handler) => windowEvents.set(name, handler) },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const box = { left: 20, top: 40, right: 520, bottom: 440, width: 500, height: 400 };
  const controller = createCropOverlay({
    canvas: { width: 1000, height: 800, classList: { toggle() {} }, getBoundingClientRect: () => box },
    workspace: { append() {}, scrollLeft: 0, scrollTop: 0, addEventListener() {}, getBoundingClientRect: () => box },
    isActive: () => true, getCrop: () => crop,
    onBegin: () => { before = { ...crop }; }, onChange: next => { crop = next; },
    onEnd: cancelled => { ended.push(cancelled); if (cancelled) crop = before; },
  });
  const overlay = nodes[0];
  const event = (x, y, pointerId = 1) => ({ pointerId, button: 0, clientX: 20 + x / 2,
    clientY: 40 + y / 2, target: overlay, preventDefault() {} });
  return { controller, overlay, event, frames, ended, crop: () => plain(crop),
    blur: () => windowEvents.get("blur")?.(),
    frame: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
  };
}

test("crop ignores another pointer's cancellation and commits the owner's final coordinate once", () => {
  const f = fixture();
  f.overlay.fire("pointerdown", f.event(200, 200));
  f.overlay.fire("pointermove", f.event(300, 250));
  f.overlay.fire("pointercancel", f.event(0, 0, 2));
  f.overlay.fire("lostpointercapture", f.event(0, 0, 2));
  assert.deepEqual(f.ended, []);
  f.overlay.fire("pointerup", f.event(350, 300)); f.frame();
  assert.deepEqual(f.crop(), { x: 250, y: 200, w: 400, h: 300 });
  assert.deepEqual(f.ended, [false]);
  assert.equal(f.overlay.hasPointerCapture(1), false);
});

test("crop cancellation, capture loss, blur and explicit cancel restore the draft and discard queued input", () => {
  for (const ending of ["pointercancel", "lostpointercapture", "blur", "cancel"]) {
    const f = fixture(), original = f.crop();
    f.overlay.fire("pointerdown", f.event(200, 200));
    f.overlay.fire("pointermove", f.event(300, 250)); f.frame();
    assert.notDeepEqual(f.crop(), original);
    f.overlay.fire("pointermove", f.event(400, 300));
    if (ending === "blur") f.blur();
    else if (ending === "cancel") f.controller.cancel();
    else f.overlay.fire(ending, f.event(400, 300));
    f.frame(); f.overlay.fire("pointerup", f.event(500, 400));
    assert.deepEqual(f.crop(), original, ending);
    assert.equal(f.frames.size, 0);
    assert.equal(f.overlay.hasPointerCapture(1), false);
    assert.deepEqual(f.ended, [true]);
  }
});

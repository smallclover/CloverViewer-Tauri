const assert = require("node:assert/strict");
const test = require("node:test");
const { createSingleImageController } = require("../../.unit-test-dist/compiled/viewer/single-image-controller.js");

function createSurface() {
  const listeners = new Map();
  const classes = new Set();
  return {
    style: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    },
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: (name, handler) => listeners.set(name, handler),
    dispatch: (name, event = {}) => listeners.get(name)?.(event),
  };
}

function setup() {
  const stage = createSurface();
  const image = { ...createSurface(), naturalWidth: 1600, naturalHeight: 1200 };
  global.window = createSurface();
  const controller = createSingleImageController({
    stage,
    getImage: () => image,
    isActive: () => true,
    getZoomSensitivity: () => 1,
    onChange: () => {},
  });
  const mouseDown = (button = 0, target = stage) => stage.dispatch("mousedown", {
    button, target, clientX: 100, clientY: 100,
  });
  return { stage, image, controller, mouseDown };
}

const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8);
const viewOf = image => {
  const match = /translate\(calc\(-50% \+ ([-\d.e]+)px\), calc\(-50% \+ ([-\d.e]+)px\)\) scale\(([-\d.e]+)\)/.exec(image.style.transform);
  assert(match);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
};
function withAnimation(run, reducedMotion = false) {
  const originals = Object.fromEntries(["requestAnimationFrame", "cancelAnimationFrame", "matchMedia"].map(key => [key, global[key]]));
  const frames = new Map();
  let id = 0;
  global.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  global.cancelAnimationFrame = frame => frames.delete(frame);
  global.matchMedia = () => ({ matches: reducedMotion });
  const tick = time => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(time));
  };
  try { run({ ...setup(), frames, tick }); }
  finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  }
}
const wheel = (stage, deltaY = -120, clientX = 600, clientY = 400) => stage.dispatch("wheel", { preventDefault() {}, deltaY, clientX, clientY });

test("revealing an OCR source preserves the visible zoom and interrupts an unfinished transition", () => {
  withAnimation(({ image, controller, frames, tick }) => {
    controller.reset(); controller.actualSize(); tick(0); tick(75);
    const before = viewOf(image);
    controller.panBy(50,-30);
    const after = viewOf(image);
    near(after.scale,before.scale); near(after.x,before.x+50); near(after.y,before.y-30);
    assert.equal(frames.size,0);
  });
});

test("zoom moves smoothly while keeping the image point under the cursor fixed", () => {
  withAnimation(({ stage, image, controller, frames, tick }) => {
    controller.reset();
    const original = viewOf(image);
    wheel(stage);
    near(viewOf(image).scale, original.scale);
    const world = { x: 200 / original.scale, y: 100 / original.scale };
    tick(0); tick(75);
    const middle = viewOf(image);
    assert(middle.scale > original.scale && middle.scale < controller.displayedScale());
    near(middle.x + world.x * middle.scale, 200);
    near(middle.y + world.y * middle.scale, 100);
    tick(150);
    near(viewOf(image).scale, original.scale * Math.exp(0.18));
    assert.equal(frames.size, 0);
  });
});

test("continuous wheel zoom accumulates input and retargets the visible frame at a new cursor", () => {
  withAnimation(({ stage, image, controller, frames, tick }) => {
    controller.reset();
    const initialScale = controller.displayedScale();
    wheel(stage); tick(0); tick(60);
    const visible = viewOf(image);
    const world = { x: (-200 - visible.x) / visible.scale, y: (-150 - visible.y) / visible.scale };
    const stale = [...frames.values()][0];
    wheel(stage, -120, 200, 150);
    assert.deepEqual(viewOf(image), visible);
    assert.equal(frames.size, 1);
    stale(200);
    assert.deepEqual(viewOf(image), visible);
    tick(80); tick(155);
    const middle = viewOf(image);
    near(middle.x + world.x * middle.scale, -200);
    near(middle.y + world.y * middle.scale, -150);
    tick(230);
    near(viewOf(image).scale, initialScale * Math.exp(0.36));
  });
});

test("dragging interrupts zoom at the current view and follows the pointer without a jump", () => {
  withAnimation(({ image, controller, mouseDown, frames, tick }) => {
    controller.reset(); controller.actualSize(); tick(0); tick(60);
    const visible = viewOf(image);
    const stale = [...frames.values()][0];
    mouseDown();
    assert.equal(frames.size, 0);
    near(controller.displayedScale(), visible.scale);
    window.dispatch("mousemove", { clientX: 100, clientY: 100 });
    assert.deepEqual(viewOf(image), visible);
    window.dispatch("mousemove", { clientX: 140, clientY: 130 });
    near(viewOf(image).x, visible.x + 40);
    near(viewOf(image).y, visible.y + 30);
    stale(200);
    near(viewOf(image).scale, visible.scale);
    controller.zoomToFit(); tick(300); tick(375);
    mouseDown();
    assert.equal(frames.size, 0, "fitting animation can also be interrupted by dragging");
  });
});

test("reset cancels stale zoom frames and reduced motion switches size immediately", () => {
  withAnimation(({ stage, image, controller, frames, tick }) => {
    controller.reset(); wheel(stage); tick(0);
    const stale = [...frames.values()][0];
    controller.reset();
    const reset = image.style.transform;
    stale(300);
    assert.equal(image.style.transform, reset);
    assert.equal(frames.size, 0);
  });
  withAnimation(({ image, controller, frames }) => {
    controller.reset(); controller.actualSize();
    near(viewOf(image).scale, 1);
    controller.zoomToFit();
    near(viewOf(image).scale, 0.44);
    assert.equal(frames.size, 0);
  }, true);
});

test("fit view has no pan cursor; actual size and zoom enable dragging", () => {
  const { stage, controller, mouseDown } = setup();
  controller.reset();
  assert.equal(stage.classList.contains("can-pan"), false);
  mouseDown();
  assert.equal(stage.classList.contains("panning"), false);
  controller.actualSize();
  assert.equal(stage.classList.contains("can-pan"), true);
  mouseDown();
  assert.equal(stage.classList.contains("panning"), true);
  controller.zoomToFit();
  assert.equal(stage.classList.contains("can-pan"), false);
  assert.equal(stage.classList.contains("panning"), false);
  stage.dispatch("wheel", { preventDefault() {}, deltaY: -100, clientX: 400, clientY: 300 });
  assert.equal(stage.classList.contains("can-pan"), true);
});

test("right click and navigation buttons do not start dragging", () => {
  const { stage, controller, mouseDown } = setup();
  controller.actualSize();
  mouseDown(2);
  assert.equal(stage.classList.contains("panning"), false);
  mouseDown(0, { closest: () => ({}) });
  assert.equal(stage.classList.contains("panning"), false);
});

test("reset, mouse release and losing focus end a drag without leaving a hand cursor", () => {
  const { stage, image, controller, mouseDown } = setup();
  for (const endDrag of [() => controller.reset(), () => window.dispatch("mouseup"), () => window.dispatch("blur")]) {
    controller.actualSize();
    mouseDown();
    endDrag();
    assert.equal(stage.classList.contains("panning"), false);
    const transform = image.style.transform;
    window.dispatch("mousemove", { clientX: 200, clientY: 200 });
    assert.equal(image.style.transform, transform);
  }
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSingleImageController } = require("../../.unit-test-dist/viewer/single-image-controller.js");

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
    image,
    isActive: () => true,
    getZoomSensitivity: () => 1,
    onChange: () => {},
    playEnterAnimation: () => {},
  });
  const mouseDown = (button = 0, target = stage) => stage.dispatch("mousedown", {
    button, target, clientX: 100, clientY: 100,
  });
  return { stage, image, controller, mouseDown };
}

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

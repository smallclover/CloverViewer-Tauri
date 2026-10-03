const assert = require("node:assert/strict");
const test = require("node:test");
const { createCanvasMosaicRenderer } = require("../../.unit-test-dist/image-editor/canvas-mosaic-renderer.js");

function fixture(callback, width = 64, height = 48) {
  const previous = global.document;
  const sampling = [];
  const outputs = [];
  const paths = [];
  const source = { width, height };
  global.document = { createElement: () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({ clearRect() {}, drawImage: (...args) => sampling.push(args),
      getImageData: () => { throw new Error("Mosaic must not synchronously read pixels"); } });
    return canvas;
  } };
  const target = { save() {}, restore() {}, clearRect() {}, beginPath() {}, moveTo() {}, closePath() {}, clip() {},
    arc: (...args) => paths.push(args), drawImage: (...args) => outputs.push(args) };
  try { callback({ source, target, sampling, outputs, paths, renderer: createCanvasMosaicRenderer(source) }); }
  finally { global.document = previous; }
}

test("mosaic samples the original once per size and reuses its texture across brush positions and colors", () => {
  fixture(({ source, renderer, target, sampling, outputs }) => {
    const shape = { tool: "mosaic", points: [{ x: 1, y: 1 }], blockSize: 16, color: "#f00" };
    renderer.drawShape(target, shape);
    renderer.drawShape(target, { ...shape, points: [{ x: 15, y: 15 }], color: "#00f" });
    assert.equal(sampling.length, 2, "one downsample and one nearest-neighbor expansion");
    assert.equal(sampling[0][0], source);
    assert.deepEqual(sampling[0].slice(1), [0, 0, 4, 3]);
    assert.equal(outputs[0][0], outputs[1][0], "different positions reuse the same fixed color texture");
    assert.equal(target.imageSmoothingEnabled, false);
    renderer.reset(); renderer.drawShape(target, shape);
    assert.equal(sampling.length, 4, "a new source revision invalidates the texture cache");
  });
});

test("completed strokes replay exactly the same round segments as the live preview", () => {
  fixture(({ renderer, target, sampling, outputs, paths }) => {
    const points = [{ x: 1, y: 1 }, { x: 63, y: 1 }, { x: 1, y: 1 }];
    renderer.drawShape(target, { points, blockSize: 16 });
    assert.equal(outputs.length, 3);
    assert.equal(sampling.length, 2);
    assert.ok(paths.every(args => args[2] === 8), "brush radius matches half of the cursor diameter");
    assert.deepEqual(outputs[1].slice(5), [0, 0, 64, 10]);
    const committed = outputs.slice();
    const committedPaths = paths.slice();
    outputs.length = 0; paths.length = 0;
    for (let index = 0; index < points.length; index++) renderer.drawSegment(target, points[Math.max(0, index - 1)], points[index], 16);
    assert.deepEqual(outputs, committed, "preview and committed strokes must draw the same texture regions in the same order");
    assert.deepEqual(paths, committedPaths, "round caps must not change when releasing the pointer");
  });
  fixture(({ renderer, target, sampling, outputs }) => {
    renderer.drawShape(target, { points: [{ x: 34, y: 30 }], blockSize: 16 });
    assert.deepEqual(sampling[0].slice(1), [0, 0, 35 / 16, 31 / 16]);
    assert.deepEqual(outputs[0].slice(5), [25, 21, 10, 10]);
  }, 35, 31);
});

test("changing the size releases the previous full-size texture and invalid inputs do no drawing", () => {
  fixture(({ renderer, target, sampling, outputs }) => {
    renderer.drawSegment(target, { x: 20, y: 20 }, { x: 30, y: 30 }, 16);
    const previous = outputs[0][0];
    renderer.drawSegment(target, { x: 20, y: 20 }, { x: 30, y: 30 }, 8);
    assert.equal(previous.width, 0);
    assert.equal(sampling.length, 4);
    for (const size of [0, -1, NaN, Infinity]) renderer.drawSegment(target, { x: 1, y: 1 }, { x: 2, y: 2 }, size);
    renderer.drawSegment(target, { x: NaN, y: Infinity }, { x: NaN, y: Infinity }, 16);
    assert.equal(outputs.length, 2);
  });
});

const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");

function fixture() {
  const canvases = [];
  const { composeEditedImage } = loadTs("image-editor/export-image.ts", {}, {
    document: { createElement() {
      const calls = [];
      const context = {
        drawImage: (...args) => calls.push(["image", ...args]),
        save: () => calls.push(["save"]),
        translate: (...args) => calls.push(["translate", ...args]),
        restore: () => calls.push(["restore"]),
      };
      const canvas = { width: 0, height: 0, calls, context, getContext: () => context };
      canvases.push(canvas);
      return canvas;
    } },
  });
  const source = { width: 1000, height: 600 };
  const shapes = [{ tool: "text", text: "keep", start: { x: 130, y: 80 } }];
  const compose = overrides => composeEditedImage({ source, shapes, crop: null, scale: 1,
    drawShape: (target, shape) => canvases.find(c => c.context === target).calls.push(["shape", shape]), ...overrides });
  return { compose, canvases, source, shapes };
}

test("editor export crops the source and translates annotations from image coordinates", () => {
  const f = fixture();
  const output = f.compose({ crop: { x: 100, y: 50, w: 400.4, h: 200.6 } });
  assert.equal(output.width, 400);
  assert.equal(output.height, 201);
  assert.deepEqual(output.calls, [
    ["image", f.source, 100, 50, 400.4, 200.6, 0, 0, 400, 201],
    ["save"], ["translate", -100, -50], ["shape", f.shapes[0]], ["restore"],
  ]);
  assert.deepEqual(f.shapes[0].start, { x: 130, y: 80 });
  assert.equal(f.source.width, 1000);
});

test("scaled export resamples the complete composite and releases the intermediate canvas", () => {
  const f = fixture();
  const output = f.compose({ crop: { x: 100, y: 50, w: 400, h: 200 }, scale: 0.5 });
  assert.equal(output.width, 200);
  assert.equal(output.height, 100);
  assert.deepEqual(output.calls, [["image", f.canvases[0], 0, 0, 200, 100]]);
  assert.equal(output.context.imageSmoothingEnabled, true);
  assert.equal(f.canvases[0].width, 0);
  assert.equal(f.canvases[0].height, 0);
  assert.equal(f.source.width, 1000);
});

test("full-size export uses the entire source when no usable crop is applied", () => {
  for (const crop of [null, { x: 10, y: 10, w: 1, h: 1 }]) {
    const f = fixture();
    const output = f.compose({ crop });
    assert.equal(output.width, 1000);
    assert.equal(output.height, 600);
    assert.equal(f.canvases.length, 1);
    assert.deepEqual(output.calls[0], ["image", f.source, 0, 0, 1000, 600, 0, 0, 1000, 600]);
  }
});

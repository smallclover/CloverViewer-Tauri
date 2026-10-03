const assert = require("node:assert/strict");
const test = require("node:test");
const { createAnnotationLayers } = require("../../.unit-test-dist/screenshot/annotation-layers.js");

function fixture(callback) {
  const previous = global.document;
  const segments = [];
  const shapesDrawn = [];
  global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {} }) }) };
  const layers = createAnnotationLayers({ getSize: () => ({ width: 1920, height: 1080 }),
    drawShape: (_context, shape) => shapesDrawn.push(shape),
    drawMosaicSegment: (_context, start, end, size) => segments.push({ start, end, size }),
  });
  try { callback({ layers, segments, shapesDrawn, target: { drawImage() {} } }); }
  finally { global.document = previous; }
}

const shape = () => ({ tool: "mosaic", start: { x: 1, y: 1 }, end: { x: 1, y: 1 },
  blockSize: 16, strokeWidth: 16, points: [{ x: 1, y: 1 }] });

test("a long active mosaic stroke appends only new segments and does not replay on idle frames", () => {
  fixture(({ layers, segments, target }) => {
    const current = shape();
    layers.draw(target, [], current);
    for (let index = 1; index < 1000; index++) {
      current.points.push({ x: index + 1, y: 1 });
      layers.draw(target, [], current);
    }
    assert.equal(segments.length, 1000);
    for (let index = 0; index < 100; index++) layers.draw(target, [], current);
    assert.equal(segments.length, 1000, "no work repeats merely because the pointer hovers");
    current.points.push({ x: 1001, y: 1 }); layers.draw(target, [], current);
    assert.equal(segments.length, 1001);
    assert.equal(segments.at(-1).start.x, 1000);
  });
});

test("committed annotations rebuild on edits, undo and source changes while other frames reuse them", () => {
  fixture(({ layers, shapesDrawn, target }) => {
    const committed = shape();
    for (let index = 0; index < 100; index++) layers.draw(target, [committed], null);
    assert.equal(shapesDrawn.length, 1);
    committed.end = { x: 50, y: 10 };
    layers.draw(target, [committed], null);
    assert.equal(shapesDrawn.length, 2);
    layers.draw(target, [], null); layers.draw(target, [committed], null);
    assert.equal(shapesDrawn.length, 3);
    layers.reset(); layers.draw(target, [committed], null);
    assert.equal(shapesDrawn.length, 4);
  });
});

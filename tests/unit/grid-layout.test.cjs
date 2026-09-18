const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGridLayout,
  thumbnailPixelSize,
  visibleItemRange,
} = require("../../.unit-test-dist/viewer/grid-layout.js");

test("grid layout derives stable dimensions and never creates a negative empty-grid height", () => {
  const layout = createGridLayout(1000, 10, 172);

  assert.deepEqual(layout, {
    columns: 5,
    cellWidth: 172,
    thumbHeight: 128,
    cellHeight: 180,
    totalHeight: 376,
  });
  assert.equal(createGridLayout(1000, 0, 172).totalHeight, 0);
  assert.equal(createGridLayout(50, 1, 172).columns, 1);
});

test("virtualization retains a buffer around the viewport without crossing item boundaries", () => {
  const layout = createGridLayout(1000, 100, 172);

  assert.deepEqual(visibleItemRange(0, 196, 100, layout), [0, 15]);
  assert.deepEqual(visibleItemRange(980, 196, 100, layout), [15, 40]);
  assert.deepEqual(visibleItemRange(99_999, 196, 100, layout), [100, 100]);
});

test("thumbnail requests account for high-DPI displays and respect the request cap", () => {
  const previousWindow = global.window;
  global.window = { devicePixelRatio: 2 };
  try {
    assert.equal(thumbnailPixelSize(172), 344);
    assert.equal(thumbnailPixelSize(300), 384);
  } finally {
    global.window = previousWindow;
  }
});

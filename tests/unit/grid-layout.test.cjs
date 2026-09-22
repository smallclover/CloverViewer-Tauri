const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGridLayout,
  createGridSections,
  thumbnailPixelSize,
  visibleItemRange,
} = require("../../.unit-test-dist/viewer/grid-layout.js");

test("grid layout fills the available width and never creates a negative empty-grid height", () => {
  const layout = createGridLayout(1000, 10, 4);

  assert.deepEqual(layout, {
    columns: 4,
    cellWidth: 214,
    thumbHeight: 134,
    cellHeight: 134,
    totalHeight: 434,
  });
  assert.equal(createGridLayout(1000, 0, 4).totalHeight, 0);
  assert.equal(createGridLayout(50, 1, 4).columns, 1);
});

test("date sections reserve a heading and keep each month on its own image rows", () => {
  const layout = createGridLayout(1000, 5, 4);
  const grouped = createGridSections(["2026-04", "2026-04", "2026-04", "2026-03", "2026-03"], layout);

  assert.deepEqual(grouped.sections, [
    { startIndex: 0, itemCount: 3, top: 0, itemsTop: 32, itemsBottom: 166 },
    { startIndex: 3, itemCount: 2, top: 182, itemsTop: 214, itemsBottom: 348 },
  ]);
  assert.equal(grouped.totalHeight, 348);
});

test("virtualization retains a buffer around the viewport without crossing item boundaries", () => {
  const layout = createGridLayout(1000, 100, 4);

  assert.deepEqual(visibleItemRange(0, 196, 100, layout), [0, 16]);
  assert.deepEqual(visibleItemRange(980, 196, 100, layout), [16, 40]);
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

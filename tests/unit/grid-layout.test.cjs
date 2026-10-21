const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGridLayout,
  createGridSections,
  thumbnailPixelSize,
  visibleSectionItems,
} = require("../../.unit-test-dist/compiled/viewer/grid-layout.js");

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
    { startIndex: 0, itemCount: 3, top: 0, itemsTop: 48, itemsBottom: 182 },
    { startIndex: 3, itemCount: 2, top: 210, itemsTop: 258, itemsBottom: 392 },
  ]);
  assert.equal(grouped.totalHeight, 392);
});

test("grouped virtualization buffers rows across month boundaries without inventing items", () => {
  const layout = { ...createGridLayout(1000, 17, 4), cellHeight: 100 };
  const keys = [...Array(5).fill("April"), ...Array(3).fill("March"), ...Array(9).fill("February")];
  const { sections } = createGridSections(keys, layout);
  const visible = (top, height) => [...visibleSectionItems(top, height, sections, layout)];

  assert.deepEqual(visible(0, 80), [0, 1, 2, 3, 4]);
  assert.deepEqual(visible(140, 80), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(visible(500, 40), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(visible(99_999, 80), []);
  assert.deepEqual([...visibleSectionItems(0, 80, [], layout)], []);
});

test("month heading gaps do not manufacture visible rows and scrolling back restores them", () => {
  const layout = { ...createGridLayout(1000, 2, 4), cellHeight: 1 };
  const { sections } = createGridSections(["April", "March"], layout);
  assert.deepEqual([...visibleSectionItems(90, 1, sections, layout)], []);
  assert.deepEqual([...visibleSectionItems(125, 1, sections, layout)], [1]);
  assert.deepEqual([...visibleSectionItems(48, 1, sections, layout)], [0]);
});

test("grouped virtualization respects changed column counts and the final partial row", () => {
  const layout = { ...createGridLayout(50, 5, 4), cellHeight: 100 };
  const { sections } = createGridSections(["April", "April", "March", "March", "March"], layout);
  assert.equal(layout.columns, 1);
  assert.deepEqual([...visibleSectionItems(450, 50, sections, layout)], [1, 2, 3, 4]);
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

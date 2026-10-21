const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const { createViewerPanels } = loadTs("viewer/viewer-panels.ts");

function fixture() {
  const images = ["a", "b"].map(path => ({ path, name: path }));
  const session = { images, viewMode: "grid", activeIndex: -1, propsVisible: false };
  const panel = () => { const classes = new Set(["collapsed"]); return { classList: {
    add: name => classes.add(name), remove: name => classes.delete(name),
    toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
    contains: name => classes.has(name),
  } }; };
  const properties = panel(), share = panel();
  const events = []; let ocrOpen = false, hasResult = true, layouts = 0;
  const panels = createViewerPanels({
    session, properties: { panel: properties, render: entry => events.push(["properties", entry]) },
    share: { panel: share, open: entry => events.push(["share", entry]), close: () => events.push(["closeShare"]) },
    ocr: { open: entry => { ocrOpen = true; events.push(["ocr", entry]); }, close: () => { ocrOpen = false; events.push(["closeOcr"]); },
      isOpen: () => ocrOpen, hasResult: () => hasResult },
    showImage(index) {
      session.activeIndex = index;
      panels.closeTransient();
      session.viewMode = "single";
      panels.applyProperties();
    },
    onLayout: () => { layouts++; },
  });
  return { panels, session, properties, share, events, ocrOpen: () => ocrOpen,
    layouts: () => layouts, setResult: value => { hasResult = value; } };
}

test("viewer sidebars remain mutually exclusive through nested image navigation with one layout", () => {
  const f = fixture();
  assert.equal(f.panels.openShare(f.session.images[1]), true);
  assert.equal(f.session.activeIndex, 1); assert.equal(f.layouts(), 1);
  assert.equal(f.share.classList.contains("collapsed"), false);
  assert.equal(f.properties.classList.contains("collapsed"), true);
  f.panels.openOcr(f.session.images[0]);
  assert.equal(f.session.activeIndex, 0); assert.equal(f.layouts(), 2);
  assert.equal(f.share.classList.contains("collapsed"), true); assert.equal(f.ocrOpen(), true);
  f.panels.openProperties(f.session.images[1]);
  assert.equal(f.ocrOpen(), false); assert.equal(f.session.propsVisible, true);
  assert.equal(f.properties.classList.contains("collapsed"), false);
  assert.equal(f.layouts(), 3);
  assert.deepEqual(f.events.at(-1), ["properties", f.session.images[1]]);
});

test("missing OCR or stale context entries cannot navigate, close another panel or create a share", () => {
  const f = fixture(); f.panels.openProperties(f.session.images[0]);
  const count = f.events.length, layouts = f.layouts();
  f.setResult(false);
  assert.equal(f.panels.openOcr(f.session.images[1]), false);
  assert.equal(f.panels.openShare({ path: "deleted" }), false);
  assert.equal(f.panels.openProperties({ path: "deleted" }), false);
  assert.equal(f.session.activeIndex, 0); assert.equal(f.session.propsVisible, true);
  assert.equal(f.events.length, count); assert.equal(f.layouts(), layouts);
  f.session.images[0] = { path: "a", name: "fresh" };
  f.panels.openShare({ path: "a", name: "stale" });
  assert.deepEqual(f.events.at(-1), ["share", f.session.images[0]]);
});

test("image navigation preserves the properties preference; entering edit clears all sidebars", () => {
  const f = fixture(); f.panels.openProperties(f.session.images[0]);
  f.session.activeIndex = 1; f.panels.applyProperties();
  assert.deepEqual(f.events.at(-1), ["properties", f.session.images[1]]);
  f.session.viewMode = "grid";
  const layouts = f.layouts(); f.panels.closeTransient(); f.panels.refreshProperties();
  assert.equal(f.session.propsVisible, true); assert.equal(f.layouts(), layouts);
  f.panels.closeAll();
  assert.equal(f.session.propsVisible, false);
  assert.equal(f.properties.classList.contains("collapsed"), true);
  assert.equal(f.share.classList.contains("collapsed"), true);
  assert.equal(f.ocrOpen(), false);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");

test("screenshot viewport reuses its bounds until a resize or a new session", () => {
  let resize, windowResize, reads = 0;
  let box = { left: 0, top: 0, width: 1920, height: 1080 };
  const element = { getBoundingClientRect: () => { reads++; return box; } };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync("src/screenshot/viewport.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports,
    ResizeObserver: class { constructor(callback) { resize = callback; } observe(target) { assert.equal(target, element); } },
    window: { addEventListener: (_event, callback) => { windowResize = callback; } },
  });
  const viewport = exports.createViewportBounds(element);
  for (let index = 0; index < 1000; index++) assert.equal(viewport.get(), box);
  assert.equal(reads, 1);
  box = { ...box, width: 960 }; resize();
  assert.equal(viewport.get(), box); assert.equal(reads, 2);
  windowResize(); viewport.get(); assert.equal(reads, 3);
  viewport.invalidate(); viewport.get(); assert.equal(reads, 4);
});

test("screenshot toolbar layout stays cached while the cursor moves on the same monitor", () => {
  let resize, layoutReads = 0, positions = 0, anchor = { x: 10, y: 10 };
  let selection = { x: 100, y: 100, w: 300, h: 200 };
  const element = () => ({ style: {}, addEventListener() {},
    get offsetWidth() { layoutReads++; return 100; },
    get offsetHeight() { layoutReads++; return 30; },
    getBoundingClientRect: () => { layoutReads++; return { left: 0, right: 1920, top: 0, bottom: 1080 }; },
  });
  const toolbar = element(), help = element();
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync("src/screenshot/editor-ui-controller.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports,
    require: () => ({ placeSelectionOverlay: () => { positions++; return { x: 100, y: 350 }; } }),
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} },
    window: { addEventListener() {} },
  });
  const ui = exports.createEditorUiController({ root: element(),
    toolbarUi: { toolbar, colorBtn: element(), widthBtn: element(), closePopups() {} },
    helpPanel: { element: help, sync() {} },
    getSelection: () => selection, getAnchor: () => anchor, toCssBox: value => value,
    rootBox: () => ({ x: 0, y: 0, w: 1920, h: 1080 }),
    monitorBox: () => ({ x: anchor.x >= 1920 ? 1920 : 0, y: 0, w: 1920, h: 1080 }),
    getColor: () => "#f00", getCopyColorHotkey: () => "Alt+C", getMagnifierActive: () => true,
  });
  ui.sync(); const initialReads = layoutReads;
  for (let index = 0; index < 1000; index++) { anchor = { x: index, y: 100 }; ui.sync(); }
  assert.equal(layoutReads, initialReads); assert.equal(positions, 1);
  anchor = { x: 2000, y: 100 }; ui.sync(); assert.equal(positions, 2);
  selection = { ...selection, w: 350 }; ui.sync(); assert.equal(positions, 3);
  resize(); assert.equal(positions, 4);
  ui.updateHelp(); ui.sync(); assert.equal(positions, 5);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");

const { shellCssValues } = loadTs("ui/window-shell.ts", { "../api": {} });
test("physical shell geometry stays fixed across UI zoom and display DPI", () => {
  for (const dpi of [1, 1.25, 1.5, 2, 3]) {
    for (const zoom of [1, 1.1, 1.25, 1.5]) {
      for (const scale of [60, 100, 140]) {
        const model = {
          insets: { left: 10 * dpi, top: 120 * scale / 100 * dpi, right: 10 * dpi, bottom: 10 * dpi },
          artworkWidth: 240 * scale / 100 * dpi, artworkHeight: 120 * scale / 100 * dpi,
          controlsWidth: 150 * dpi,
        };
        const css = shellCssValues(model, dpi * zoom);
        assert.ok(Math.abs(parseFloat(css["--art-width"]) * dpi * zoom - model.artworkWidth) < 0.0001);
        assert.ok(Math.abs(parseFloat(css["--shell-top"]) * dpi * zoom - model.insets.top) < 0.0001);
      }
    }
  }
});

test("screenshots acknowledge only the latest hidden layer after painting", async () => {
  const frames = [], acknowledged = [], styles = {};
  let onLayout;
  const image = () => ({ setAttribute() {}, getAttribute() {}, decode: async () => {} });
  const layout = { insets: { left: 10, top: 110, right: 10, bottom: 10 }, style: "peek", artworkWidth: 240, artworkHeight: 120, controlsWidth: 150, captureId: null };
  const root = { dataset: {}, style: { setProperty: (key, value) => { styles[key] = value; } } };
  const { initializeWindowShell } = loadTs("ui/window-shell.ts", { "../api": {
    initializeWindowDecoration: async () => layout,
    listenWindowShellLayout: async handler => { onLayout = handler; return () => {}; },
    windowShellCaptureReady: async id => { acknowledged.push(id); },
  } }, {
    document: { documentElement: root, createElement: image, body: { append() {} } },
    window: { devicePixelRatio: 1.5, addEventListener() {}, removeEventListener() {} },
    Image: class { decode() { return Promise.resolve(); } },
    requestAnimationFrame: callback => frames.push(callback),
  });
  await initializeWindowShell(error => { throw error; });
  onLayout({ ...layout, style: "off", captureId: 7 });
  assert.equal(root.dataset.shellStyle, "off");
  assert.deepEqual(acknowledged, []);
  frames.shift()();
  assert.deepEqual(acknowledged, []);
  frames.shift()();
  assert.deepEqual(acknowledged, [7]);
  onLayout({ ...layout, style: "off", captureId: 8 });
  onLayout(layout);
  while (frames.length) frames.shift()();
  assert.deepEqual(acknowledged, [7]);
  assert.equal(root.dataset.shellStyle, "peek");
  assert.equal(styles["--art-width"], "160px");
});

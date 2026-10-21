const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(deferredLoads = false) {
  function element() {
    const classes = new Set(), handlers = new Map();
    const node = {
      children: [], dataset: {}, attributes: {}, offsetWidth: 40, clientWidth: 100, scrollLeft: 0,
      get offsetLeft() { return (node.parent?.children.indexOf(node) ?? 0) * 50; },
      get className() { return [...classes].join(" "); },
      set className(value) { classes.clear(); value.split(" ").forEach(c => classes.add(c)); },
      classList: { contains: c => classes.has(c), toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } },
      setAttribute: (key, value) => { node.attributes[key] = value; },
      addEventListener: (name, handler) => handlers.set(name, handler),
      fire: (name, event) => handlers.get(name)?.(event),
      appendChild(child) { node.insertBefore(child, null); },
      insertBefore(child, before) { child.remove(); const i = before ? node.children.indexOf(before) : node.children.length; node.children.splice(i, 0, child); child.parent = node; },
      remove() { if (node.parent) { node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; } },
      querySelector: () => node.children.find(child => child.classList.contains("active")),
    };
    return node;
  }
  const strip = element(), toggle = element(), selected = [], loads = [];
  let resized, toggles = 0;
  const session = { images: Array.from({ length: 7 }, (_, i) => ({ path: `${i}.png`, name: `${i}`, modified: "now", size: 1 })) };
  const { createImagePreviewStripController } = loadTs("viewer/image-preview-strip-controller.ts", {}, {
    document: { createElement: element }, ResizeObserver: class { constructor(callback) { resized = callback; } observe() {} },
  });
  const controller = createImagePreviewStripController({
    strip, toggle, session, imageSource: { for: async entry => `fallback:${entry.path}` },
    getThumbnail: path => deferredLoads ? new Promise(resolve => loads.push({ path, resolve })) : Promise.resolve(`thumb:${path}`),
    onSelect: index => selected.push(index), onToggle: () => toggles++, translate: key => key,
  });
  return { controller, strip, toggle, session, selected, loads, resized: () => resized(), toggles: () => toggles };
}

test("preview strip reuses neighboring nodes, centers the active image and resolves clicks after reordering", async () => {
  const f = fixture();
  f.controller.render(2); await flush();
  const old = [...f.strip.children];
  f.controller.render(3); await flush();
  assert.equal(f.strip.children.length, 5);
  assert.equal(f.strip.children[0], old[1]);
  assert.equal(f.strip.children[2].attributes["aria-current"], "true");
  assert.equal(f.strip.children[2].children[0].src, "thumb:3.png");
  assert.equal(f.strip.scrollLeft, 70);
  f.strip.scrollLeft = 0; f.resized(); assert.equal(f.strip.scrollLeft, 70);
  f.session.images.reverse();
  old[1].fire("click"); assert.deepEqual(f.selected, [5]);
  f.controller.render(5);
  assert.deepEqual(f.strip.children.map(button => button.title), ["3", "2", "1", "0"]);
});

test("clearing a preview suppresses late thumbnails even when a new list contains the same path", async () => {
  const f = fixture(true);
  f.session.images = f.session.images.slice(0, 1);
  f.controller.render(0);
  const old = f.strip.children[0].children[0];
  f.controller.clear(); f.controller.render(0);
  const current = f.strip.children[0].children[0];
  f.loads[0].resolve("old"); await flush();
  assert.equal(old.src, undefined); assert.equal(current.src, undefined);
  f.loads[1].resolve("new"); await flush();
  assert.equal(current.src, "new");
});

test("preview controls retain Tab focus navigation and update visibility and accessible labels", () => {
  const f = fixture(); let stopped = 0, prevented = 0;
  for (const node of [f.strip, f.toggle]) {
    node.fire("keydown", { key: "Tab", stopPropagation() { stopped++; }, preventDefault() { prevented++; } });
    node.fire("keydown", { key: "ArrowRight", stopPropagation() { stopped++; } });
  }
  assert.equal(stopped, 2); assert.equal(prevented, 0);
  f.controller.setVisible(false);
  assert.equal(f.strip.classList.contains("hidden"), true);
  assert.equal(f.toggle.ariaExpanded, "false");
  assert.equal(f.toggle.ariaLabel, "view.showImagePreviews");
  f.controller.setVisible(true); f.controller.setAvailable(false);
  assert.equal(f.strip.classList.contains("hidden"), false);
  assert.equal(f.toggle.classList.contains("hidden"), true);
  assert.equal(f.toggle.ariaLabel, "view.hideImagePreviews");
  f.toggle.fire("click"); assert.equal(f.toggles(), 1);
});

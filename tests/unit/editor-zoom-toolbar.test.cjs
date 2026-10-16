const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");

test("zoom controls live in the bottom dock before save and retain all actions and labels", () => {
  function element(tag) {
    const attributes = new Map(), handlers = new Map(), classes = new Set();
    return {
      tag, children: [], style: {setProperty() {}}, value: "", dataset: {}, offsetHeight: 0,
      classList: {add: name => classes.add(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)},
      append(...nodes) {this.children.push(...nodes);},
      replaceChildren(...nodes) {this.children = nodes;},
      setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name),
      addEventListener: (name, handler) => handlers.set(name, handler),
      click: () => handlers.get("click")?.(),
    };
  }
  const globals = {
    document: {createElement: element, addEventListener() {}},
    ResizeObserver: class {observe() {}},
    Option: function(text, value) {return {...element("option"), text, value};},
  };
  const {createEditorToolbar} = loadTs("image-editor/toolbar.ts", {
    "../ui/select-control": {createSelectControl: () => ({refresh() {}, close() {}})},
  }, globals);
  const workspace = element("workspace");
  const noop = () => {};
  const toolbar = createEditorToolbar({workspace, translate: key => key, setTool: noop,
    rotate: noop, undo: noop, redo: noop, saveAs: noop, overwrite: noop, close: noop});
  const calls = [];
  const {createEditorZoomToolbar} = loadTs("image-editor/zoom-toolbar.ts", {}, globals);
  const zoom = createEditorZoomToolbar({container: toolbar.zoomSlot, translate: key => key,
    zoom: factor => calls.push(factor), fit: () => calls.push("fit"), actualSize: () => calls.push("actual")});
  const dock = toolbar.element.children[1];
  assert.equal(workspace.children.length,1);
  assert.equal(dock.children.at(-2),toolbar.zoomSlot);
  assert.equal(dock.children.at(-1).className,"image-editor-island image-editor-saving");
  const island = toolbar.zoomSlot.children[0];
  const buttons = island.children.filter(node => node.tag === "button");
  assert.equal(buttons.length,4);
  buttons.forEach(button => {assert.ok(button.ariaLabel); button.click();});
  assert.deepEqual(calls,[1/1.2,1.2,"fit","actual"]);
  zoom.setScale(1.6);
  assert.equal(island.children[1].textContent,"160%");
});

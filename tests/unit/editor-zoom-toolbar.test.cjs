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
      click() {if (!this.disabled) handlers.get("click")?.();},
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
  let rotations = 0; const toolChanges=[];
  const toolbar = createEditorToolbar({workspace, translate: key => key, setTool: tool => toolChanges.push(tool),
    rotate: () => {rotations++;}, deleteSelected: noop, applyCrop: noop, cancelCrop: noop, undo: noop, redo: noop, reset: noop, saveAs: noop, overwrite: noop, close: noop});
  const calls = [];
  const {createEditorZoomToolbar} = loadTs("image-editor/zoom-toolbar.ts", {}, globals);
  let language="";
  const zoom = createEditorZoomToolbar({container: toolbar.zoomSlot, translate: key => language+key,
    zoom: factor => calls.push(factor), fit: () => calls.push("fit"), actualSize: () => calls.push("actual")});
  const dock = toolbar.element.children[0];
  assert.equal(workspace.children.length,1);
  assert.equal(dock.children.at(-2),toolbar.zoomSlot);
  assert.equal(dock.children.at(-1).className,"image-editor-island image-editor-saving");
  const toolStack = dock.children.find(node => node.className === "image-editor-tool-stack");
  const context = toolStack.children[0];
  const tools = toolStack.children[1];
  assert.equal(context.className, "image-editor-context image-editor-island");
  assert.equal(context.hidden, true, "idle editor has no adjustment panel");
  assert.equal(tools.className, "image-editor-island image-editor-tools");
  const reset = dock.children[0].children.find(node => node.dataset?.key === "editor.reset");
  assert.match(reset.innerHTML, /<svg/);
  assert.equal(reset.children.length, 0);
  assert.equal(reset.title, "editor.reset");
  const rotate = tools.children.find(node => node.dataset?.key === "editor.rotate");
  assert.ok(rotate);
  assert.equal(tools.children.some(node=>node.dataset?.key === "editor.select"),false);
  const rect=tools.children.find(node=>node.dataset?.key === "shot.rect");
  rect.click();assert.equal(toolChanges.at(-1),"rect");
  toolbar.setActiveTool("rect");assert.equal(context.hidden,false);rect.click();assert.equal(toolChanges.at(-1),"select");
  toolbar.setActiveTool("select");
  assert.equal(context.hidden,true,"returning to adjustment without a selection hides the panel");
  assert.match(rotate.innerHTML, /<svg/);
  assert.equal(rotate.children.length,0);
  rotate.click(); assert.equal(rotations,1);
  toolbar.setSelection(true);
  assert.equal(context.hidden,false);
  const selectionActions=context.children[2];
  assert.equal(selectionActions.hidden,false);
  assert.equal(selectionActions.children[0].dataset.key,"editor.deleteAnnotation");
  toolbar.setSelection(false);assert.equal(selectionActions.hidden,true);assert.equal(context.hidden,true);
  toolbar.refreshTranslations();assert.equal(context.hidden,true,"language refresh does not reopen the idle panel");
  toolbar.setActiveTool("crop");
  assert.equal(context.hidden,false,"crop actions remain available");
  const cropActions=context.children[1];
  assert.deepEqual(cropActions.children.map(node => node.dataset.key),["editor.cancelCrop","editor.applyCrop"]);
  assert.equal(rotate.disabled,true);
  assert.equal(rotate.title,"editor.finishCropFirst");
  rotate.click(); assert.equal(rotations,1);
  toolbar.setActiveTool("text");
  assert.equal(rotate.disabled,false);
  rotate.click(); assert.equal(rotations,2);
  const island = toolbar.zoomSlot.children[0];
  const buttons = island.children.filter(node => node.tag === "button");
  assert.equal(buttons.length,4);
  assert.match(buttons[2].innerHTML,/<svg/);
  assert.match(buttons[3].innerHTML,/<svg/);
  assert.equal(buttons[2].textContent,undefined);
  assert.equal(buttons[3].textContent,undefined);
  const fitIcon=buttons[2].innerHTML, actualIcon=buttons[3].innerHTML;
  assert.notEqual(fitIcon,actualIcon);
  buttons.forEach(button => {assert.ok(button.ariaLabel); button.click();});
  assert.deepEqual(calls,[1/1.2,1.2,"fit","actual"]);
  zoom.setScale(1.6);
  assert.equal(island.children[1].textContent,"160%");
  zoom.setScale(2,{canActualSize:false,cropping:true});
  assert.equal(buttons[3].disabled,true);
  assert.equal(buttons[3].title,"editor.actualSizeUnavailable");
  assert.equal(buttons[2].title,"editor.fitCropFrame");
  assert.match(buttons[2].innerHTML,/<svg/);
  assert.notEqual(buttons[2].innerHTML,fitIcon);
  assert.equal(buttons[3].hidden,true);
  assert.equal(island.ariaLabel,"editor.cropZoomHelp");
  buttons[3].click(); assert.equal(calls.length,4);
  language="ja:"; zoom.refreshTranslations();
  assert.equal(buttons[3].ariaLabel,"ja:editor.actualSizeUnavailable");
  zoom.setScale(1,{canActualSize:true,cropping:false});
  assert.equal(buttons[3].disabled,false);
  assert.equal(buttons[3].hidden,false);
  assert.equal(buttons[3].title,"ja:editor.pixelDetailHint");
  assert.equal(buttons[2].title,"ja:editor.showWholeHint");
  assert.equal(buttons[2].innerHTML,fitIcon);
  assert.equal(buttons[3].innerHTML,actualIcon);
  assert.equal(island.ariaLabel,"ja:editor.zoomHelp");
  buttons[3].click(); assert.equal(calls.at(-1),"actual");
});

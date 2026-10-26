const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

async function setup() {
  const timers = [];
  const frames = new Map();
  let frameId = 0;
  const drawn = [];
  const cleared = [];
  const windowHandlers = new Map();
  const confirmations = [];
  let confirmationResolver = null;
  let closed = 0;
  let active = null;
  let toolbarActions;
  let toolbar;
  let viewportOptions, cropOptions, activeTool, saveDialogCount = 0;
  let pathResolver;
  const toasts = [], saved = [];
  const beautyPanels = [];
  let previewScale = 0.2;
  const elements = [];
  const context = new Proxy({ measureText: text => ({ width: text.length * 24 }),
    clearRect: (...args) => cleared.push(args) }, { get: (target, key) => target[key] ?? (() => {}) });
  function element(tag) {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      tag, style: {}, value: "", scrollLeft: 0, scrollTop: 0, scrollHeight: 0, width: 2000, height: 1000,
      get className() { return [...classes].join(" "); },
      set className(value) { classes.clear(); for (const name of value.split(" ")) classes.add(name); },
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: name => classes.delete(name), contains: name => classes.has(name) },
      append: () => {}, replaceChildren: () => {},
      getContext: () => context,
      getBoundingClientRect: () => tag === "canvas"
        ? { left: 120, top: 80, width: 2000 * previewScale, height: 1000 * previewScale }
        : { left: 100, top: 50, width: 700, height: 500 },
      addEventListener: (name, handler) => listeners.set(name, [...(listeners.get(name) ?? []),handler]),
      fire: (name, event = {}) => {
        if (name.startsWith("pointer") || name === "lostpointercapture") event.pointerId ??= 1;
        for(const handler of listeners.get(name) ?? []) handler(event);
      },
      focus: () => { if (active && active !== el) active.blur(); active = el; },
      blur: () => { if (active !== el) return; active = null; el.fire("blur"); },
      setPointerCapture: () => { el.captured = true; },
      hasPointerCapture: () => !!el.captured,
      releasePointerCapture: () => { el.captured = false; },
    };
    elements.push(el);
    return el;
  }
  const root = element("root");
  root.classList.add("hidden");
  const exports = {};
  const source = readFileSync(resolve(__dirname, "../../src/viewer/image-editor-controller.ts"), "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports,
    document: { createElement: element },
    window: {
      addEventListener: (name, handler) => {
        const handlers = windowHandlers.get(name) ?? [];
        handlers.push(handler);
        windowHandlers.set(name, handlers);
      },
      setTimeout: callback => timers.push(callback),
      confirm: () => { throw new Error("editor exit must use an in-app confirmation"); },
    },
    require: name => {
      if (name === "../image-editor/export-image") return require("./helpers/load-ts.cjs")("image-editor/export-image.ts", {}, {document:{createElement:element}});
      if (name === "../image-beautify/workspace") return {createBeautyWorkspace: options => {
        let open = false; const panel = {options, open: () => {open=true;}, close: () => {options.completeRound();open=false;}, reset:()=>{open=false;}, isOpen: () => open,
          settle(){},refreshSession(){},refresh(){},sync(){},refreshTranslations(){},layout(){},bounds:()=>null,isDragging:()=>false};
        beautyPanels.push(panel); return panel;
      }};
      if (name.startsWith("../image-beautify/")) return require(`../../.unit-test-dist/compiled/image-beautify/${name.split("/").pop()}.js`);
      if (name === "@tauri-apps/plugin-dialog") return { save: () => {
        saveDialogCount++;
        return new Promise(resolve => { pathResolver = resolve; });
      } };
      if (name === "../image-editor/crop-transaction") return require("./helpers/load-ts.cjs")("image-editor/crop-transaction.ts");
      if (name === "../image-editor/annotation-selection") return require("./helpers/load-ts.cjs")("image-editor/annotation-selection.ts", {
        "./frame-update": {createFrameUpdate: apply => require("../../.unit-test-dist/compiled/image-editor/frame-update.js").createFrameUpdate(apply, {
          request: callback => {frames.set(++frameId,callback);return frameId;},cancel: id => frames.delete(id),
        })},
      },{document:{createElement:element}});
      if (name === "../image-editor/confirm-dialog") return { createEditorConfirmDialog: () => ({
        isOpen: () => confirmationResolver !== null,
        ask: request => {
          confirmations.push(request);
          return new Promise(resolve => { confirmationResolver = resolve; });
        },
      }) };
      if (name === "../image-editor/toolbar") return { createEditorToolbar: actions => {
        toolbarActions = actions;
        toolbar = { color: { value: "#ff0000" }, width: { addEventListener: () => {} }, sizes: { strokeWidth: 2, fontSize: 24, blockSize: 16 }, format: { value: "png" }, outputScale: { value: "100" },
          refreshTranslations: () => {}, refreshHistory: (undo,redo) => {toolbar.canUndo=undo;toolbar.canRedo=redo;}, setSelection: selected => {toolbar.selected=selected;}, setActiveTool: tool => {activeTool=tool;}, closePanels: () => {}, updateLayout: () => {},
          resetSizes: () => {
            Object.assign(toolbar.sizes, require("../../.unit-test-dist/compiled/image-editor/annotation-style.js").createAnnotationSizes());
          } };
        return toolbar;
      } };
      if (name === "./image-editor-loader") return { createImageEditorLoader: () => ({
        load: async () => ({ naturalWidth: 2000, naturalHeight: 1000, removeAttribute() {} }), cancel: () => {}, isLoading: () => false,
      }) };
      if (name === "../image-editor/crop-overlay") return { createCropOverlay: options => {
        cropOptions=options;
        return { update: () => {}, refreshImage: () => {}, cancel: () => options.onEnd(true) };
      } };
      if (name === "../image-editor/crop-viewport") return { createCropViewport: options => { viewportOptions = options; return { fit: () => {}, refresh: () => {}, begin: () => {}, end: () => {} }; } };
      if (name === "../image-editor/zoom-toolbar") return {createEditorZoomToolbar: () => ({refreshTranslations() {}, setScale() {}})};
      if (name === "../image-editor/viewport-input") return {bindEditorViewportInput: () => ({reset() {}})};
      if (name === "../image-editor/mosaic-cursor") return { createMosaicCursor: () => ({ refresh: () => {}, reset: () => {} }) };
      if (name === "../image-editor/annotation-renderer") return { drawAnnotation: (_target, shape) => drawn.push(shape) };
      if (name === "../image-editor/annotation-layers") {
        const layerExports = {};
        runInNewContext(readFileSync(resolve(__dirname, "../../.unit-test-dist/compiled/image-editor/annotation-layers.js"), "utf8"), {
          exports: layerExports, document: { createElement: element },
        });
        return layerExports;
      }
      if (name === "../image-editor/frame-update") return { createFrameUpdate: apply =>
        require("../../.unit-test-dist/compiled/image-editor/frame-update.js").createFrameUpdate(apply, {
          request: callback => { frames.set(++frameId, callback); return frameId; },
          cancel: id => frames.delete(id),
        }) };
      if (name === "../image-editor/canvas-mosaic-renderer") return {
        mosaicBlockSize: shape => shape.blockSize,
        createCanvasMosaicRenderer: () => ({ reset: () => {},
          drawSegment: (_target, start, end) => drawn.push({ tool: "mosaic-segment", start, end }),
          drawShape: (_target, shape) => drawn.push(shape),
        }),
      };
      return require(`../../.unit-test-dist/compiled/image-editor/${name.split("/").pop()}.js`);
    },
  });
  const controller = exports.createImageEditorController({
    root, getEditableSource: async () => "", saveImage: async (...args) => {saved.push(args);}, translate: (key, params) => params?.msg ? `${key}: ${params.msg}` : key,
    onClose: () => { closed++; }, onSaved: () => {}, toast: (...args) => toasts.push(args),
  });
  await controller.open({ path: "image.png", name: "image.png" }, () => {});
  toolbarActions.setTool("text");
  const canvas = elements.find(el => el.className === "image-editor-canvas");
  const input = elements.find(el => el.tag === "textarea");
  const click = (x = 300, y = 160) => {
    const event = { clientX: x, clientY: y, button: 0, pointerId: 1, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; } };
    canvas.fire("pointerdown", event);
    // 模拟浏览器默认行为：pointerdown 处理器返回后，未 preventDefault 才发生焦点切换。
    if (!event.defaultPrevented) active?.blur();
    return event;
  };
  const key = overrides => {
    const event = { key: "Enter", isComposing: false, keyCode: 13, shiftKey: false, prevented: false,
      stopPropagation: () => {}, preventDefault() { this.prevented = true; }, ...overrides };
    input.fire("keydown", event);
    return event;
  };
  return { controller, input, canvas, click, key, drawn, cleared, toolbarActions, toolbar, root, confirmations,
    toasts, saved, beautyPanels, activeTool: () => activeTool, saveDialogs: () => saveDialogCount,
    resolvePath: async path => {pathResolver(path); await new Promise(resolve => setImmediate(resolve));},
    changeCropView: value => viewportOptions.onCropChange(value),
    cropGesture: (value, cancelled=false) => {cropOptions.onBegin(); cropOptions.onChange(value); cropOptions.onEnd(cancelled);},
    crop: () => JSON.parse(JSON.stringify(viewportOptions.getCrop())),
    closed: () => closed,
    resolveConfirmation: async accepted => {
      assert.ok(confirmationResolver);
      const resolve = confirmationResolver;
      confirmationResolver = null;
      resolve(accepted);
      await new Promise(resolve => setImmediate(resolve));
    },
    windowKey: overrides => {
      const event = { key: "Escape", ctrlKey: false, preventDefault: () => {}, ...overrides };
      for (const handler of windowHandlers.get("keydown") ?? []) handler(event);
    },
    paint: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
    resizePreview: scale => { previewScale = scale; },
    flush: () => { while (timers.length) timers.shift()(); }, focused: () => active === input };
}

test("integrated beautification edits immediately share editor undo, redo, reset and exit protection", async () => {
  const f = await setup(); f.toolbarActions.setTool("select");
  const preview = async () => { f.toolbarActions.beautify(); await new Promise(resolve=>setImmediate(resolve)); return f.beautyPanels.at(-1); };
  let panel = await preview();
  assert.ok(panel, JSON.stringify(f.toasts));
  panel.options.edit(d=>{d.enabled=true;d.frame.kind="solid";});
  assert.equal(panel.options.getDocument().enabled,true);
  panel.options.edit(d=>{d.frame.radius=20;},"radius");
  panel.options.edit(d=>{d.frame.radius=30;},"radius");
  f.toolbarActions.undo(); assert.equal(panel.options.getDocument().frame.radius,16);
  assert.equal(panel.options.getDocument().enabled,false);
  f.toolbarActions.redo(); assert.equal(panel.options.getDocument().enabled,true);
  f.toolbarActions.reset(); assert.equal(panel.options.getDocument().enabled,false);
  f.toolbarActions.undo(); assert.equal(panel.options.getDocument().enabled,true);
  const leaving=f.controller.close(); assert.equal(f.confirmations.length,1);
  await f.resolveConfirmation(false); assert.equal(await leaving,false);
});

test("a screenshot edit context opens the inspector with its original document and frozen time",async()=>{
 const f=await setup();const document=require("../../.unit-test-dist/compiled/image-beautify/model.js").emptyBeauty();
 document.enabled=true;document.frame.kind="gradient";
 await f.controller.open({path:"capture.png",name:"capture.png"},()=>{},{document,capturedAt:1792886400000});
 const pane=f.beautyPanels.at(-1);assert.ok(pane.isOpen());assert.equal(pane.options.getDocument().enabled,true);
 assert.equal(pane.options.getTime().getTime(),1792886400000);
});

test("select moves an annotation as one undo step and toolbar deletion can be undone", async () => {
  const f=await setup();f.click();f.flush();f.input.value="move";f.key();
  const original=JSON.parse(JSON.stringify(f.drawn.at(-1)));
  f.toolbarActions.setTool("select");f.click();
  assert.equal(f.toolbar.selected,true);
  f.canvas.fire("pointermove",{clientX:320,clientY:180,pointerId:1});f.paint();
  f.canvas.fire("pointerup",{clientX:340,clientY:200,pointerId:1});
  assert.equal(f.drawn.at(-1).start.x,original.start.x+200);
  assert.equal(f.drawn.at(-1).start.y,original.start.y+200);
  f.toolbarActions.undo();assert.equal(f.drawn.at(-1).start.x,original.start.x);
  f.toolbarActions.redo();assert.equal(f.drawn.at(-1).start.x,original.start.x+200);
  f.click(340,200);f.canvas.fire("pointerup",{clientX:340,clientY:200,pointerId:1});
  f.toolbarActions.deleteSelected();assert.equal(f.toolbar.selected,false);
  f.toolbarActions.undo();assert.equal(f.drawn.at(-1).start.x,original.start.x+200);
});

test("finished arrows, boxes and ellipses are immediately selected and movable without a tool switch",async()=>{
  for(const tool of ["rect","circle","arrow"]) {
    const f=await setup();f.toolbarActions.setTool(tool);f.click(200,150);
    f.canvas.fire("pointerup",{clientX:300,clientY:210,pointerId:1});
    assert.equal(f.activeTool(),"select");assert.equal(f.toolbar.selected,true);
    const original=JSON.parse(JSON.stringify(f.drawn.at(-1)));
    const x=tool==="circle"?250:200;
    f.click(x,150);f.canvas.fire("pointerup",{clientX:x+20,clientY:170,pointerId:1});
    assert.equal(f.drawn.at(-1).start.x,original.start.x+100);
    assert.equal(f.drawn.at(-1).start.y,original.start.y+100);
    f.toolbarActions.undo();assert.equal(f.drawn.at(-1).start.x,original.start.x);
    f.toolbarActions.redo();assert.equal(f.drawn.at(-1).start.x,original.start.x+100);
    f.toolbarActions.setTool(tool);f.click(350,150);
    f.canvas.fire("pointerup",{clientX:400,clientY:210,pointerId:1});
    assert.equal(f.toolbar.selected,true,"the next completed shape is also ready to adjust");
  }
});

test("committing text immediately selects it while freehand tools retain continuous drawing",async()=>{
  const text=await setup();text.click();text.flush();text.input.value="adjust now";text.key();
  assert.equal(text.activeTool(),"select");assert.equal(text.toolbar.selected,true);
  for(const tool of ["pen","mosaic"]) {
    const f=await setup();f.toolbarActions.setTool(tool);
    for(let i=0;i<2;i++) {
      f.click(200+i*50,150);f.canvas.fire("pointerup",{clientX:250+i*50,clientY:180,pointerId:1});
      assert.equal(f.activeTool(),tool);assert.equal(f.toolbar.selected,false);
    }
  }
});

test("clicking away from entered text commits and selects it without opening another input",async()=>{
  const f=await setup();f.click();f.flush();f.input.value="move immediately";
  f.click(400,220);f.flush();
  assert.equal(f.input.classList.contains("hidden"),true);
  assert.equal(f.activeTool(),"select");assert.equal(f.toolbar.selected,true);
  const original=JSON.parse(JSON.stringify(f.drawn.at(-1)));
  assert.equal(original.text,"move immediately");
  f.click();f.canvas.fire("pointerup",{clientX:320,clientY:180,pointerId:1});
  assert.equal(f.drawn.at(-1).start.x,original.start.x+100);
  assert.equal(f.drawn.at(-1).start.y,original.start.y+100);
  f.toolbarActions.undo();assert.equal(f.drawn.at(-1).start.x,original.start.x);
});

test("Enter commits text before delayed input focus and duplicate blur does not clear selection",async()=>{
  const f=await setup();f.click();f.input.value="fast input";f.key();f.flush();
  assert.equal(f.activeTool(),"select");assert.equal(f.toolbar.selected,true);
  assert.equal(f.input.classList.contains("hidden"),true);
  f.input.fire("blur");assert.equal(f.toolbar.selected,true);
  assert.equal(f.drawn.filter(shape=>shape.tool==="text").length,1);
});

test("drawing after switching tools preserves earlier annotations and allows reselecting each later",async()=>{
  const f=await setup();
  const draw=(tool,x,y,endX,endY)=>{
    f.toolbarActions.setTool(tool);f.click(x,y);
    f.canvas.fire("pointerup",{clientX:endX,clientY:endY,pointerId:1});
  };
  draw("arrow",200,150,280,200);
  const first=JSON.parse(JSON.stringify(f.drawn.at(-1)));
  draw("rect",350,150,400,200);
  draw("arrow",200,150,250,150);
  const arrows=f.drawn.filter(shape=>shape.tool==="arrow");
  assert.equal(arrows.at(-2).start.x,first.start.x);
  assert.equal(arrows.at(-2).end.x,first.end.x,"drawing over an old arrow must not move it");
  // Hit an earlier arrow away from the overlapping new arrow, then move it.
  f.click(264,190);f.canvas.fire("pointerup",{clientX:284,clientY:210,pointerId:1});
  assert.equal(f.drawn.filter(shape=>shape.tool==="arrow").at(-2).start.x,first.start.x+100);
  // The previous rectangle can also be reselected after multiple tool switches.
  f.click(350,150);f.canvas.fire("pointerup",{clientX:370,clientY:170,pointerId:1});
  assert.equal(f.drawn.filter(shape=>shape.tool==="rect").at(-1).start.x,1250);
});

test("reset clears annotations, applied crop and rotation in one undoable step", async () => {
  const f=await setup();f.click();f.flush();f.input.value="restore me";f.key();
  f.toolbarActions.setTool("crop");f.cropGesture({x:100,y:100,w:1500,h:700});f.toolbarActions.applyCrop();
  f.toolbarActions.rotate();const before=f.crop();
  f.toolbarActions.reset();
  assert.equal(f.crop(),null);assert.equal(f.canvas.width,2000);assert.equal(f.toolbar.selected,false);
  f.toolbarActions.undo();
  assert.deepEqual(f.crop(),before);assert.equal(f.canvas.width,1000);
  assert.equal(f.drawn.at(-1).text,"restore me");assert.equal(f.drawn.at(-1).rotation,90);
  f.toolbarActions.redo();assert.equal(f.crop(),null);assert.equal(f.canvas.width,2000);
});

test("reset cancels crop drafts and keeps unfinished text recoverable; resetting untouched state creates no edit", async () => {
  const f=await setup();f.toolbarActions.reset();f.windowKey();
  assert.equal(f.confirmations.length,0);assert.equal(f.closed(),1);
  const g=await setup();g.click();g.flush();g.input.value="pending";g.toolbarActions.reset();
  assert.equal(g.input.classList.contains("hidden"),true);
  g.toolbarActions.undo();assert.equal(g.drawn.at(-1).text,"pending");
  g.toolbarActions.setTool("crop");g.changeCropView({x:200,y:100,w:1200,h:600});
  g.toolbarActions.reset();assert.equal(g.crop(),null);assert.equal(g.activeTool(),"select");
  g.toolbarActions.undo();assert.equal(g.crop(),null);assert.equal(g.drawn.at(-1).text,"pending");
});

test("canceling an annotation move restores its position without an extra edit", async () => {
  const f=await setup();f.click();f.flush();f.input.value="stay";f.key();
  f.toolbarActions.setTool("select");f.click();
  f.canvas.fire("pointermove",{clientX:340,clientY:200,pointerId:1});f.paint();
  f.canvas.fire("pointercancel");
  assert.equal(f.drawn.at(-1).start.x,900);
  f.toolbarActions.undo();
  assert.equal(f.toolbar.selected,false);
  f.toolbarActions.redo();assert.equal(f.drawn.at(-1).start.x,900);
});

test("crop changes stay tentative until explicitly applied and commit as one undo step", async () => {
  const editor = await setup();
  editor.toolbarActions.setTool("crop");
  const first = {x:200,y:100,w:1600,h:800};
  const last = {x:400,y:200,w:1200,h:600};
  editor.changeCropView(first);
  editor.changeCropView(last);
  assert.deepEqual(editor.crop(),last);
  editor.toolbarActions.setTool("select");
  assert.equal(editor.activeTool(),"crop");
  assert.equal(editor.toasts.at(-1)[0],"editor.finishCropFirst");
  editor.toolbarActions.undo(); editor.toolbarActions.redo();
  assert.deepEqual(editor.crop(),last);
  editor.toolbarActions.applyCrop();
  assert.equal(editor.activeTool(),"select");
  editor.toolbarActions.undo(); assert.equal(editor.crop(),null);
  editor.toolbarActions.redo(); assert.deepEqual(editor.crop(),last);
  editor.toolbarActions.setTool("crop");
  editor.changeCropView(first);
  editor.toolbarActions.cancelCrop();
  assert.deepEqual(editor.crop(),last);
});

test("Escape cancels draft crop without closing; rotation waits until the crop is resolved", async () => {
  const editor=await setup();
  editor.toolbarActions.setTool("crop");
  editor.changeCropView({x:200,y:100,w:1600,h:800});
  editor.toolbarActions.rotate();
  assert.equal(editor.canvas.width,2000);
  assert.equal(editor.toasts.at(-1)[0],"editor.finishCropFirst");
  editor.windowKey({key:"Escape"});
  assert.equal(editor.canvas.width,2000);
  assert.equal(editor.crop(),null);
  assert.equal(editor.activeTool(),"select");
  assert.equal(editor.closed(),0);
  editor.toolbarActions.undo();
  assert.equal(editor.canvas.width,2000);
  editor.windowKey({key:"Escape"});
  assert.equal(editor.confirmations.length,0);
  assert.equal(editor.closed(),1);
});

test("rotation commits independently and canceling a later crop preserves the rotated annotations", async () => {
  const editor=await setup();
  editor.click(); editor.flush(); editor.input.value="keep"; editor.key();
  const original=JSON.stringify(editor.drawn.at(-1));
  editor.toolbarActions.setTool("crop");
  const crop={x:200,y:100,w:1600,h:800};
  editor.cropGesture(crop);
  editor.toolbarActions.applyCrop();
  editor.toolbarActions.rotate();
  assert.notEqual(JSON.stringify(editor.drawn.at(-1)),original);
  const rotated=JSON.stringify(editor.drawn.at(-1)), rotatedCrop=editor.crop();
  editor.toolbarActions.setTool("crop");
  editor.changeCropView({x:100,y:200,w:600,h:1200});
  editor.toolbarActions.cancelCrop();
  assert.equal(JSON.stringify(editor.drawn.at(-1)),rotated);
  assert.deepEqual(editor.crop(),rotatedCrop);
  editor.toolbarActions.undo();
  assert.deepEqual(editor.crop(),crop);
  assert.equal(JSON.stringify(editor.drawn.at(-1)),original);
  assert.equal(editor.canvas.width,2000);
  editor.toolbarActions.redo();
  assert.deepEqual(editor.crop(),rotatedCrop);
  assert.equal(editor.canvas.width,1000);
});

test("standalone rotation commits unfinished text first and keeps its own undo step", async () => {
  const editor=await setup();
  editor.click(); editor.flush(); editor.input.value="rotate me";
  editor.toolbarActions.rotate();
  assert.equal(editor.input.classList.contains("hidden"),true);
  assert.equal(editor.canvas.width,1000);
  assert.equal(editor.drawn.at(-1).text,"rotate me");
  assert.equal(editor.drawn.at(-1).rotation,90);
  editor.toolbarActions.undo();
  assert.equal(editor.canvas.width,2000);
  assert.equal(editor.drawn.at(-1).rotation ?? 0,0);
  assert.equal(editor.drawn.at(-1).text,"rotate me");
});

test("pending crop blocks saving and close cancellation retains the draft", async () => {
  const editor=await setup();
  editor.toolbarActions.setTool("crop");
  const crop={x:200,y:100,w:1600,h:800};
  editor.changeCropView(crop);
  editor.toolbarActions.saveAs(); editor.toolbarActions.overwrite();
  assert.equal(editor.saveDialogs(),0);
  assert.equal(editor.confirmations.length,0);
  const closing=editor.controller.close();
  assert.equal(editor.confirmations.length,1);
  await editor.resolveConfirmation(false);
  assert.equal(await closing,false);
  assert.deepEqual(editor.crop(),crop);
  assert.equal(editor.activeTool(),"crop");
  editor.windowKey({key:"Enter"});
  assert.equal(editor.activeTool(),"select");
  editor.toolbarActions.saveAs();
  assert.equal(editor.saveDialogs(),1);
  await editor.resolvePath(null);
});

test("enter respects focused controls and IME; a canceled gesture retains the preceding draft", async () => {
  const editor=await setup();
  editor.toolbarActions.setTool("crop");
  const crop={x:200,y:100,w:1600,h:800};
  editor.cropGesture(crop);
  editor.cropGesture({x:400,y:200,w:1200,h:600},true);
  assert.deepEqual(editor.crop(),crop);
  for(const extra of [{isComposing:true},{repeat:true},{defaultPrevented:true},{target:{closest:()=>true}}]) {
    editor.windowKey({key:"Enter",...extra});
    assert.equal(editor.activeTool(),"crop");
  }
  editor.windowKey({key:"Enter"});
  assert.equal(editor.activeTool(),"select");
  editor.toolbarActions.undo(); assert.equal(editor.crop(),null);
});

test("a late save dialog cannot export an unconfirmed crop and a new session clears its draft", async () => {
  const editor=await setup();
  editor.toolbarActions.saveAs();
  editor.toolbarActions.setTool("crop");
  editor.changeCropView({x:200,y:100,w:1600,h:800});
  await editor.resolvePath("copy.png");
  assert.equal(editor.saved.length,0);
  assert.match(editor.toasts.at(-1)[0],/editor.finishCropFirst/);
  await editor.controller.open({path:"other.png",name:"other.png"},()=>{});
  assert.equal(editor.activeTool(),"select");
  assert.equal(editor.crop(),null);
  editor.windowKey();
  assert.equal(editor.confirmations.length,0);
  assert.equal(editor.closed(),1);
});

test("Escape leaves an untouched editor without a discard prompt", async () => {
  const fixture = await setup();
  fixture.windowKey();
  assert.equal(fixture.confirmations.length, 0);
  assert.equal(fixture.closed(), 1);
  assert.equal(fixture.root.classList.contains("hidden"), true);
});

test("rectangle, ellipse and arrow commit the exact release point without a final move", async () => {
  for (const tool of ["rect", "circle", "arrow"]) {
    const f = await setup(); f.toolbarActions.setTool(tool); f.click(200,150);
    f.canvas.fire("pointermove", {clientX:300, clientY:200});
    f.canvas.fire("pointerup", {clientX:400, clientY:250, pointerId:1});
    assert.equal(f.drawn.at(-1).end.x, 1400); assert.equal(f.drawn.at(-1).end.y, 850);
  }
});

test("cancelled or lost pointer capture discards unfinished drawing and ignores late release", async () => {
  for (const event of ["pointercancel", "lostpointercapture"]) {
    const f = await setup(); f.toolbarActions.setTool("rect"); f.click();
    f.canvas.fire("pointermove", {clientX:400, clientY:250}); f.canvas.fire(event);
    const count = f.drawn.length;
    f.canvas.fire("pointerup", {clientX:400, clientY:250, pointerId:1});
    assert.equal(f.drawn.length, count); f.windowKey();
    assert.equal(f.confirmations.length, 0); assert.equal(f.closed(), 1);
  }
});

test("Escape after annotation waits for confirmation; cancellation retains edits and repeated Escape cannot bypass it", async () => {
  const fixture = await setup();
  fixture.click();
  fixture.input.value = "保留这条标注";
  fixture.key();
  fixture.windowKey();
  fixture.windowKey();
  await fixture.controller.close();
  assert.equal(fixture.confirmations.length, 1);
  assert.equal(fixture.confirmations[0].confirmLabel, "editor.discardAndExit");
  assert.equal(fixture.confirmations[0].cancelLabel, "editor.continueEditing");
  assert.equal(fixture.closed(), 0);
  assert.equal(fixture.root.classList.contains("hidden"), false);
  await fixture.resolveConfirmation(false);
  assert.equal(fixture.closed(), 0);
  assert.equal(fixture.drawn.at(-1).text, "保留这条标注");
  fixture.windowKey();
  assert.equal(fixture.confirmations.length, 2);
  await fixture.resolveConfirmation(true);
  assert.equal(fixture.closed(), 1);
  assert.equal(fixture.root.classList.contains("hidden"), true);
});

test("closing from the toolbar preserves unfinished text before asking to discard it", async () => {
  const fixture = await setup();
  fixture.click();
  fixture.input.value = "尚未提交的文字";
  fixture.toolbarActions.close();
  assert.equal(fixture.confirmations.length, 1);
  assert.equal(fixture.drawn.at(-1).text, "尚未提交的文字");
  assert.equal(fixture.closed(), 0);
  await fixture.resolveConfirmation(false);
  assert.equal(fixture.root.classList.contains("hidden"), false);
});

test("rotating an image also requires confirmation before Escape exits", async () => {
  const fixture = await setup();
  fixture.toolbarActions.rotate();
  fixture.windowKey();
  assert.equal(fixture.confirmations.length, 1);
  assert.equal(fixture.closed(), 0);
  await fixture.resolveConfirmation(false);
  assert.equal(fixture.closed(), 0);
});

test("clicking the image keeps the text field open and focuses after pointer default handling", async () => {
  const fixture = await setup();
  assert.equal(fixture.click().defaultPrevented, true);
  assert.equal(fixture.canvas.captured, undefined);
  assert.equal(fixture.input.classList.contains("hidden"), false);
  assert.equal(fixture.focused(), false);
  fixture.flush();
  assert.equal(fixture.focused(), true);
  assert.equal(fixture.input.style.left, "191px");
  assert.equal(fixture.input.style.top, "103px");
  assert.equal(parseFloat(fixture.input.style.font.split(" ")[1]), 24);
  fixture.input.value = "输入文字";
  fixture.key();
  assert.equal(fixture.input.classList.contains("hidden"), true);
  assert.equal(fixture.drawn[0].text, "输入文字");
  assert.equal(fixture.drawn[0].start.x, 900);
  assert.equal(fixture.drawn[0].start.y, 400);
  assert.equal(fixture.drawn[0].fontSize, 120);
  assert.equal(fixture.drawn[0].strokeWidth, 10);
  assert.equal(fixture.drawn[0].end.x, 996);
  assert.equal(fixture.drawn[0].end.y, 544);
});

test("mosaic retains every input point, paints once per frame and commits a returning stroke", async () => {
  const fixture = await setup();
  fixture.toolbarActions.setTool("mosaic");
  fixture.click(300, 160);
  fixture.drawn.length = 0;
  for (let index = 1; index <= 20; index++) fixture.canvas.fire("pointermove", {
    clientX: 300 + index, clientY: 160 + index, pointerId: 1,
  });
  assert.equal(fixture.drawn.length, 0, "input events only queue a display frame");
  fixture.paint();
  assert.equal(fixture.drawn.length, 20);
  const region = fixture.cleared.at(-1);
  assert.ok(region[2] < 200 && region[3] < 200, "editor refreshes only the newly painted region");
  fixture.canvas.fire("pointerup", { clientX: 300, clientY: 160, pointerId: 1 });
  const committed = fixture.drawn.find(item => item.tool === "mosaic");
  assert.ok(committed, "a stroke returning to its origin must be kept");
  assert.equal(committed.points.length, 22);
  fixture.paint();
  assert.equal(fixture.drawn.filter(item => item.tool === "mosaic").length, 1);
});

test("manual screen sizes survive tool switches and adapt new text to the latest preview zoom", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush(); fixture.input.value = "First"; fixture.key();
  const first = JSON.stringify(fixture.drawn[0]);
  fixture.toolbar.sizes.fontSize = 32;
  fixture.toolbar.sizes.strokeWidth = 4;
  fixture.toolbarActions.setTool("rect");
  fixture.toolbarActions.setTool("text");
  fixture.resizePreview(0.1);
  fixture.click(); fixture.flush(); fixture.input.value = "Second"; fixture.key();
  assert.equal(parseFloat(fixture.input.style.font.split(" ")[1]), 32);
  assert.equal(fixture.toolbar.sizes.fontSize, 32);
  assert.equal(fixture.toolbar.sizes.strokeWidth, 4);
  assert.equal(fixture.drawn.at(-1).fontSize, 320);
  assert.equal(fixture.drawn.at(-1).strokeWidth, 40);
  assert.equal(JSON.stringify(fixture.drawn[0]), first);
});

test("crop enlargement keeps new strokes, arrow heads, text and mosaic at the selected screen size", async () => {
  for (const tool of ["rect", "circle", "arrow", "pen", "mosaic", "text"]) {
    const f = await setup();
    f.click(); f.flush(); f.input.value = "Before crop"; f.key();
    const original = JSON.stringify(f.drawn[0]);
    f.toolbarActions.setTool("crop");
    f.cropGesture({ x: 500, y: 200, w: 200, h: 150 });
    f.toolbarActions.applyCrop();
    f.resizePreview(2);
    f.toolbarActions.setTool(tool);
    f.click(300, 160);
    if (tool === "text") {
      f.flush();
      assert.ok(f.input.style.font.startsWith("600 24px"));
      f.input.value = "After crop"; f.key();
    } else {
      f.canvas.fire("pointerup", {clientX: 400, clientY: 260, pointerId: 1});
    }
    const shape = f.drawn.at(-1);
    assert.equal(shape.tool, tool);
    assert.equal(shape.strokeWidth * 2, 2);
    if (tool === "arrow") assert.equal(shape.arrowHeadSize * 2, 16);
    if (tool === "mosaic") assert.equal(shape.blockSize * 2, 16);
    if (tool === "text") assert.equal(shape.fontSize * 2, 24);
    assert.equal(JSON.stringify(f.drawn[0]), original, "existing annotations retain their image sizes");
    f.toolbarActions.undo(); f.toolbarActions.redo();
    assert.equal(f.drawn.at(-1).strokeWidth, shape.strokeWidth);
  }
});

test("IME confirmation and Shift+Enter remain in the text field; a normal Enter commits", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush(); fixture.input.value = "中文";
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
    assert.equal(fixture.key(options).prevented, false);
    assert.equal(fixture.input.classList.contains("hidden"), false);
    assert.equal(fixture.drawn.length, 0);
  }
  fixture.key();
  assert.equal(fixture.drawn.length, 1);
});

test("new text clicks preserve previous text and cancellation cannot be undone by a late focus timer", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush(); fixture.input.value = "第一段";
  fixture.click(400, 200);
  assert.equal(fixture.drawn[0].text, "第一段");
  fixture.key({ key: "Escape" }); fixture.flush();
  assert.equal(fixture.input.classList.contains("hidden"), true);
  fixture.click(); fixture.toolbarActions.setTool("rect"); fixture.flush();
  assert.equal(fixture.input.classList.contains("hidden"), true);
});

test("text input grows for explicit lines without changing the annotation origin or wrapping on export", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush();
  assert.equal(fixture.input.rows, 1);
  assert.equal(fixture.input.wrap, "off");
  assert.equal(fixture.input.style.width, "180px");
  assert.equal(fixture.input.style.height, "44px");
  const originalHeight = parseFloat(fixture.input.style.height);
  fixture.input.value = "Long text ".repeat(8) + "\nSecond line";
  fixture.input.fire("input");
  assert.ok(parseFloat(fixture.input.style.width) > 260);
  assert.ok(parseFloat(fixture.input.style.height) > originalHeight);
  assert.equal(fixture.input.style.left, "191px");
  assert.equal(fixture.input.style.top, "103px");
  fixture.key();
  assert.equal(fixture.drawn[0].start.x, 900);
  assert.equal(fixture.drawn[0].start.y, 400);
  assert.equal(fixture.drawn[0].text.split("\n").length, 2);
});

test("deleting text shrinks the box back to its default size and a new input starts at that size", async () => {
  const fixture = await setup();
  fixture.click(); fixture.flush();
  fixture.input.value = "Long text ".repeat(8) + "\nSecond line";
  fixture.input.fire("input");
  assert.ok(parseFloat(fixture.input.style.width) > 180);
  assert.ok(parseFloat(fixture.input.style.height) > 44);
  fixture.input.value = "Short";
  fixture.input.fire("input");
  assert.equal(fixture.input.style.width, "180px");
  assert.equal(fixture.input.style.height, "44px");
  fixture.key();
  fixture.click(400, 200); fixture.flush();
  assert.equal(fixture.input.value, "");
  assert.equal(fixture.input.style.width, "180px");
  assert.equal(fixture.input.style.height, "44px");
});

test("an edge-clamped input commits text at its visible origin and caps overflowing content", async () => {
  const fixture = await setup();
  fixture.resizePreview(1);
  fixture.click(790, 540); fixture.flush();
  fixture.input.value = "Long text ".repeat(12) + "\nSecond line\nThird line";
  fixture.input.fire("input");
  const left = parseFloat(fixture.input.style.left);
  const top = parseFloat(fixture.input.style.top);
  assert.ok(left + parseFloat(fixture.input.style.width) <= 692);
  assert.ok(top + parseFloat(fixture.input.style.height) <= 492);
  fixture.key();
  const start = fixture.drawn[0].start;
  assert.equal(start.x, left + 9 - 20);
  assert.equal(start.y, top + 7 - 30);
});


test("a beauty round coalesces across fields and ends before annotations, while the panel stays open",async()=>{
 const f=await setup();f.toolbarActions.beautify();await new Promise(r=>setImmediate(r));const p=f.beautyPanels.at(-1);
 for(const kind of ["mac-light","mac-dark","wood"])p.options.edit(d=>{d.enabled=true;d.frame.kind=kind;});
 p.options.edit(d=>{d.frame.radius=38;},"radius");
 f.toolbarActions.setTool("text");f.click();f.input.value="after beauty";f.key();
 f.toolbarActions.undo();assert.equal(p.options.getDocument().frame.kind,"wood");
 f.toolbarActions.undo();assert.equal(p.options.getDocument().enabled,false);assert.equal(f.toolbar.canUndo,false);
 f.toolbarActions.redo();assert.equal(p.options.getDocument().frame.kind,"wood");assert.equal(p.options.getDocument().frame.radius,38);
});

test("restoring this round and a net-zero round do not create an unsaved-change warning",async()=>{
 for(const restore of [true,false]){
  const f=await setup();f.toolbarActions.beautify();await new Promise(r=>setImmediate(r));const p=f.beautyPanels.at(-1);
  const before=JSON.parse(JSON.stringify(p.options.getDocument()));
  p.options.edit(d=>{d.enabled=true;d.frame.kind="wood";});
  if(restore)p.options.revertRound();else{p.options.edit(d=>Object.assign(d,before));p.close();}
  assert.equal(f.toolbar.canUndo,false);assert.equal(await f.controller.close(),true);assert.equal(f.confirmations.length,0);
 }
});

test("closing and reopening the inspector makes independently undoable beauty rounds",async()=>{
 const f=await setup();f.toolbarActions.beautify();await new Promise(r=>setImmediate(r));const p=f.beautyPanels.at(-1);
 p.options.edit(d=>{d.enabled=true;d.frame.kind="gallery";});p.close();
 f.toolbarActions.beautify();await new Promise(r=>setImmediate(r));p.options.edit(d=>{d.frame.kind="wood";});p.options.edit(d=>{d.frame.radius=33;});
 f.toolbarActions.undo();assert.equal(p.options.getDocument().frame.kind,"gallery");
 f.toolbarActions.undo();assert.equal(p.options.getDocument().enabled,false);assert.equal(f.toolbar.canUndo,false);
});

test("save starts a history boundary even when choosing a path is canceled",async()=>{
 const f=await setup();f.toolbarActions.beautify();await new Promise(r=>setImmediate(r));const p=f.beautyPanels.at(-1);
 p.options.edit(d=>{d.enabled=true;d.frame.kind="gallery";});f.toolbarActions.saveAs();
 p.options.edit(d=>{d.frame.kind="wood";});await f.resolvePath(null);
 f.toolbarActions.undo();assert.equal(p.options.getDocument().frame.kind,"gallery");
 f.toolbarActions.undo();assert.equal(p.options.getDocument().enabled,false);
});

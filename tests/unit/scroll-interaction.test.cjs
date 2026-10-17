const assert = require("node:assert/strict");
const test = require("node:test");
const {readFileSync} = require("node:fs");
const {resolve} = require("node:path");
const {runInNewContext} = require("node:vm");
const ts = require("typescript");
const loadTs = require("./helpers/load-ts.cjs");

function shortcuts() {
  let handler, phase = "capturing", editing = false;
  const calls = [];
  const {bindEditorShortcuts} = loadTs("screenshot/editor-shortcuts.ts", {}, {
    window: {addEventListener: (_name, callback) => {handler = callback;}},
  });
  bindEditorShortcuts({
    isTextEditing: () => editing, getScrollPhase: () => phase, getSelection: () => ({w:300,h:500}),
    onStopScroll: () => {calls.push("preview");phase="done";},
    onDiscardAndClose: () => {calls.push("cancel");phase="idle";},
    onFinishScroll: () => calls.push("copy-result"), onExitScroll: () => calls.push("exit"),
    onStartScroll: () => calls.push("start"), onClose: () => calls.push("close"),
    onExport: () => calls.push("copy-selection"), getCopyColorHotkey: () => "Alt+C",
    getColorPoint: () => null, onCopyColor() {}, onUndo() {}, onRedo() {}, onDelete() {},
  });
  return {calls, phase: value => {phase=value;}, editing: value => {editing=value;},
    key: (key, extra={}) => {const event={key,prevented:false,preventDefault(){this.prevented=true;},...extra};handler(event);return event;}};
}

test("scroll capture Enter completes to preview; Escape cancels without keeping a result", () => {
  const f=shortcuts();assert.equal(f.key("Enter").prevented,true);
  assert.deepEqual(f.calls,["preview"]);
  f.phase("capturing");assert.equal(f.key("Escape").prevented,true);
  assert.deepEqual(f.calls,["preview","cancel"]);
});

test("holding Enter cannot copy the result after completing capture", () => {
  const f=shortcuts();f.key("Enter");
  for(let i=0;i<4;i++) f.key("Enter",{repeat:true});
  assert.deepEqual(f.calls,["preview"]);
  f.key("Enter");assert.deepEqual(f.calls,["preview","copy-result"]);
  f.key("Escape");assert.equal(f.calls.at(-1),"cancel");
});

test("scroll shortcuts retain start/cancel and ordinary screenshot copy behavior", () => {
  const f=shortcuts();f.phase("armed");f.key("Enter");f.key("Escape");
  assert.deepEqual(f.calls,["start","exit"]);
  f.phase("idle");f.key("Enter");f.key("Escape");
  assert.deepEqual(f.calls,["start","exit","copy-selection","close"]);
  f.phase("capturing");
  f.key("Enter",{isComposing:true});f.key("Enter",{defaultPrevented:true});
  f.editing(true);f.key("Enter");f.key("Escape");
  assert.equal(f.calls.length,4);
});

test("cancelled scroll completion clears state without entering preview or error", () => {
  const {createScrollCaptureSession}=loadTs("screenshot/scroll-capture-session.ts");
  const session=createScrollCaptureSession();session.begin(true);
  session.state.progress={stage:"capturing",frames:3};
  session.receiveDone({ok:false,cancelled:true},100);
  assert.equal(session.state.phase,"idle");assert.equal(session.state.result,null);
  assert.equal(session.state.progress,null);assert.equal(session.state.error,"");
});

test("actual screenshot event handlers ignore late progress and completion after cancellation", () => {
  const {createScrollCaptureSession}=loadTs("screenshot/scroll-capture-session.ts");
  const session=createScrollCaptureSession();session.begin(true);
  let closes=0,renders=0;
  const source=readFileSync(resolve(__dirname,"../../src/screenshot.ts"),"utf8");
  const start=source.indexOf("function handleScrollProgress(");
  const handlers=ts.transpileModule(source.slice(start,source.indexOf("async function main()",start)),{
    compilerOptions:{module:ts.ModuleKind.CommonJS},
  }).outputText;
  const context={scroll:session.state,scrollSession:session,minX:0,minY:0,performance:{now:()=>100},
    scrollHud:{classList:{remove(){},toggle(){}}},scrollSelectionGlow:{classList:{remove(){},toggle(){}}},
    exitScrollMode(){closes++;session.reset();},syncScrollUi(){},render(){renders++;},
  };
  runInNewContext(handlers+";this.events={done:handleScrollDone,progress:handleScrollProgress,hud:handleScrollHud};",context);
  context.events.done({ok:false,cancelled:true});assert.equal(closes,1);
  context.events.progress({stage:"capturing",frames:5});
  context.events.done({ok:true,width:300,height:1000});
  context.events.hud({hidden:false,glow:true});
  assert.equal(session.state.phase,"idle");assert.equal(session.state.progress,null);
  assert.equal(renders,0);assert.equal(closes,1);
  session.state.phase="done";session.state.result={ok:true};
  context.events.done({ok:false,cancelled:true});
  assert.equal(closes,2,"queued native Escape also closes an already-visible preview");
  assert.equal(session.state.result,null);
});

function controllerFixture() {
  let resume, starts=0, stops=0;
  const {createScrollCaptureSession}=loadTs("screenshot/scroll-capture-session.ts");
  const session=createScrollCaptureSession();
  const {createScrollCaptureController}=loadTs("screenshot/scroll-capture-controller.ts",{
    "../api":{startScrollCapture:async()=>{starts++;},stopScrollCapture:async()=>{stops++;}},
  },{window:{setTimeout:callback=>{resume=callback;}},performance:{now:()=>10}});
  const node=()=>({style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){}});
  const tree=()=>new Proxy({}, {get:(target,key)=>target[key]??(target[key]=node())});
  const hud=tree(),panel=tree();panel.manual.checked=true;
  hud.primaryMetric={label:node(),value:node()};hud.secondaryMetric={label:node(),value:node()};
  const controller=createScrollCaptureController({session,panel,hud,root:node(),toolbar:node(),helpBox:node(),
    hideFloatingPanels(){},closePopups(){},getSelection:()=>({x:0,y:0,w:300,h:500}),getBounds:()=>({minX:0,minY:0}),
    experimentalAutoScrollEnabled:()=>true,translate:key=>key,render(){},position(){},showNotice(){},closeScreenshot:async()=>{},
  });
  return {session,controller,hud,resume:()=>resume(),starts:()=>starts,stops:()=>stops};
}

test("cancelling before the native startup delay cannot start a hidden capture", async () => {
  const f=controllerFixture();const pending=f.controller.begin();
  f.session.reset();f.resume();await pending;assert.equal(f.starts(),0);
});

test("Enter during startup still finishes the native capture once it starts", async () => {
  const f=controllerFixture();const pending=f.controller.begin();f.controller.stop();
  assert.equal(f.hud.cancelButton.textContent,"shot.scrollCancel");
  assert.equal(f.hud.stopButton.textContent,"shot.scrollManualFinish");
  f.resume();await pending;assert.equal(f.starts(),1);assert.equal(f.stops(),2);
});

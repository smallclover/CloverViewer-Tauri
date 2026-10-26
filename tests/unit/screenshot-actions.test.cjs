const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise,resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const png = deferred(), share = deferred(); const calls = [], stopped = [], shown = [], busy = [];
  const {createScreenshotActionController} = loadTs("screenshot/screenshot-action-controller.ts", {
    "../api": {startLanShare: value => {calls.push(value); return share.promise;}, stopLanShare: async id => stopped.push(id)},
    "./selection-image": {selectionToPngBase64: () => png.promise},
  });
  const controller = createScreenshotActionController({getSelection: () => ({x:0,y:0,w:10,h:10}), getScreens: () => [], getShapes: () => [],
    drawShape() {}, translate: key => key, setOcrBusy() {}, setActionBusy: value => busy.push(value), showNotice() {}, showLanShare: info => shown.push(info)});
  return {controller,png,share,calls,stopped,shown,busy};
}
test("cancelling during PNG encoding never starts a share", async () => {
  const f = setup(); const pending = f.controller.shareImage(); f.controller.reset(); f.png.resolve("png"); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.shown.length, 0);
});
test("cancelling an active share stops only its returned ID and ignores duplicate clicks", async () => {
  const f = setup(); const pending = f.controller.shareImage(); f.png.resolve("png"); await tick();
  await f.controller.shareImage(); assert.equal(f.calls.length, 1);
  f.controller.reset(); f.share.resolve({share_id: "old"}); await pending;
  assert.deepEqual(f.stopped, ["old"]); assert.equal(f.shown.length, 0);
});
test("a current share is displayed and releases action busy state", async () => {
  const f = setup(); const pending = f.controller.shareImage(); f.png.resolve("png"); f.share.resolve({share_id: "new"}); await pending;
  assert.equal(f.shown[0].share_id, "new"); assert.deepEqual(f.busy, [true,false]);
});

test("copy, save, open and share use the decorated output while OCR keeps source pixels", async () => {
  const outputs=[], originals=[], ocr=[], finished=[], shares=[];
  const {createScreenshotActionController}=loadTs("screenshot/screenshot-action-controller.ts",{
    "../api":{finishScreenshot:async (...args)=>finished.push(args),closeScreenshot:async()=>{},
      startLanShare:async png=>{shares.push(png);return {share_id:"new"};},stopLanShare:async()=>{},
      ocrImageDocument:async png=>{ocr.push(png);return {text:"recognized",lines:[]};}},
    "./selection-image":{selectionToPngBase64:async options=>{originals.push(options);return "original";}},
  },{window:{setTimeout:callback=>{callback();}}});
  const controller=createScreenshotActionController({getSelection:()=>({x:0,y:0,w:20,h:20}),getScreens:()=>[],getShapes:()=>[],drawShape(){},
    translate:key=>key,setOcrBusy(){},setActionBusy(){},showNotice(){},showLanShare(){},getOutputPng:async()=>{outputs.push(1);return "decorated";}});
  for(const action of ["clipboard","save","open"])await controller.exportImage(action);
  await controller.shareImage(); await controller.runOcr();
  assert.equal(outputs.length,4);assert.deepEqual(shares,["decorated"]);
  assert.deepEqual(finished.slice(0,3).map(call=>call[1]),["decorated","decorated","decorated"]);
  assert.deepEqual(ocr,["original"]);assert.equal(originals[0].drawAnnotations,undefined);
  assert.equal(finished.at(-1)[1],"original");
});

const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");

function fixture() {
  const calls = [];
  let resolveOcr;
  const document = {version:1,imageWidth:20,imageHeight:10,text:"Text",lines:[{id:"a",text:"Text",quad:[{x:0,y:0},{x:20,y:0},{x:20,y:10},{x:0,y:10}]}]};
  const {createScreenshotActionController} = loadTs("screenshot/screenshot-action-controller.ts", {
    "../api":{
      ocrImageDocument: () => new Promise(resolve => {resolveOcr=resolve;}),
      finishScreenshot:async (...args)=>calls.push(args),
    },
    "../ui/ocr-error":{ocrErrorMessage:String},
    "./selection-image":{selectionToPngBase64:async ()=>"png-pixels"},
  });
  const controller = createScreenshotActionController({
    getSelection:()=>({x:0,y:0,w:20,h:10}),getScreens:()=>[],getShapes:()=>[],drawShape(){},
    translate:key=>key,setOcrBusy(){},setActionBusy(){},showNotice(){},showLanShare(){},
  });
  return {controller,calls,document,complete:()=>resolveOcr(document)};
}

test("screenshot OCR opens exactly its recognized pixels with coordinates and text in one result", async () => {
  const f=fixture(), pending=f.controller.runOcr();
  await new Promise(resolve=>setImmediate(resolve)); f.complete(); await pending;
  assert.deepEqual(f.calls,[["open","png-pixels","Text",false,f.document]]);
});
test("a late OCR completion after resetting capture cannot open stale pixels", async () => {
  const f=fixture(), pending=f.controller.runOcr();
  await new Promise(resolve=>setImmediate(resolve)); f.controller.reset(); f.complete(); await pending;
  assert.deepEqual(f.calls,[]);
});

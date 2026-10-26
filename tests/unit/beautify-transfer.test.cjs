const assert=require("node:assert/strict"),test=require("node:test"),loadTs=require("./helpers/load-ts.cjs");
function setup(){
 let resolve;const encoding=new Promise(done=>{resolve=done;});const calls=[],busy=[];
 let value={enabled:false,referenceSize:1000,frame:{kind:"none"},watermarks:[]};
 const {createScreenshotBeauty}=loadTs("screenshot/beautify-controller.ts",{
  "../api":{getBeautifyLibrary:async()=>({autoApply:false}),finishScreenshot:async(...args)=>calls.push(args)},
  "./selection-image":{selectionCanvasToBase64:()=>encoding},
 });
 const controller=createScreenshotBeauty({getDocument:()=>value,setDocument:d=>{value=d;},compose:()=>({width:1280,height:720}),prepare(){},
  t:key=>key,changed(){},fail:message=>{throw Error(message);},setBusy:b=>busy.push(b)});
 return {controller,calls,busy,resolve,setDocument:d=>{value=d;}};
}
test("screenshot editing transfers undecorated pixels and an immutable beauty/time context",async()=>{
 const f=setup();f.controller.reset();const opening=f.controller.open();await new Promise(r=>setImmediate(r));
 f.setDocument({enabled:true});f.resolve("original-png");await opening;
 assert.equal(f.calls.length,1);const args=f.calls[0];assert.equal(args[0],"open");assert.equal(args[1],"original-png");
 assert.equal(args[5].document.enabled,false);assert.equal(typeof args[5].capturedAt,"number");assert.deepEqual(f.busy,[false,true,false]);
});
test("a refreshed screenshot invalidates an in-flight editor transfer before the backend call",async()=>{
 const f=setup();f.controller.reset();const opening=f.controller.open();await new Promise(r=>setImmediate(r));
 f.controller.reset();f.resolve("old-png");await opening;assert.equal(f.calls.length,0);
});

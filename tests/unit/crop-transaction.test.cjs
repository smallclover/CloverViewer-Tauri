const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const {createCropTransaction}=loadTs("image-editor/crop-transaction.ts");

function setup() {
  let current={crop:null,rotation:0,shapes:[{text:"keep"}]};
  const committed=[];
  const draft=createCropTransaction({capture:()=>current,clone:structuredClone,getSize:()=>({w:2000,h:1000}),
    restore:value=>{current=value;},commit:value=>committed.push(value)});
  return {draft,committed,get:()=>current,set:value=>{current={...current,...value};}};
}

test("crop changes stay pending, apply commits once and keeps the original snapshot isolated",()=>{
  const f=setup(); f.draft.begin();
  f.set({crop:{x:100,y:100,w:1200,h:600}}); f.get().shapes[0].text="rotated draft";
  f.draft.begin(); assert.equal(f.draft.changed(),true); assert.equal(f.committed.length,0);
  f.draft.finish(true); assert.equal(f.draft.active,false);
  assert.equal(f.committed.length,1); assert.equal(f.committed[0].crop,null);
  assert.equal(f.committed[0].shapes[0].text,"keep");
  f.draft.finish(true); assert.equal(f.committed.length,1);
});

test("cancel restores the applied crop, rotation and annotations without a history entry",()=>{
  const f=setup(); const applied={crop:{x:20,y:30,w:1000,h:500},rotation:90}; f.set(applied);
  f.draft.begin(); f.set({crop:{x:10,y:15,w:200,h:300},rotation:180,shapes:[]});
  f.draft.finish(false); assert.deepEqual(f.get(),{...applied,shapes:[{text:"keep"}]});
  assert.equal(f.committed.length,0); assert.equal(f.draft.active,false);
});

test("an unchanged full-image crop is normalized without creating an edit and clearing discards old sessions",()=>{
  const f=setup(); f.draft.begin();f.set({crop:{x:0,y:0,w:2000,h:1000}});
  assert.equal(f.draft.changed(),false);f.draft.finish(true);assert.equal(f.get().crop,null);
  assert.equal(f.committed.length,0);
  f.draft.begin();f.set({rotation:90});assert.equal(f.draft.changed(),true);
  f.draft.clear();f.set({crop:null,rotation:0,shapes:[]});f.draft.finish(false);
  assert.deepEqual(f.get(),{crop:null,rotation:0,shapes:[]});
});

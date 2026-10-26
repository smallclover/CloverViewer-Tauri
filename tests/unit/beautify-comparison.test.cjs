const assert=require('node:assert/strict'),test=require('node:test'),loadTs=require('./helpers/load-ts.cjs');
function setup(){
 const button=new EventTarget(),window=new EventTarget(),document=new EventTarget();
 const attributes=new Map(),captures=new Set(),changes=[];let allowed=true;
 button.setAttribute=(k,v)=>attributes.set(k,v);button.setPointerCapture=id=>captures.add(id);
 button.hasPointerCapture=id=>captures.has(id);button.releasePointerCapture=id=>captures.delete(id);
 const {bindHoldComparison}=loadTs('image-beautify/hold-comparison.ts',{}, {window,document});
 const hold=bindHoldComparison({button,canStart:()=>allowed,onChange:b=>changes.push(b)});
 const fire=(target,type,props={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,props);target.dispatchEvent(e);return e;};
 return {button,window,document,changes,hold,captures,attributes,fire,allow:b=>{allowed=b;}};
}
test('held comparison restores on outside release, pointer cancellation, lost capture and focus loss',()=>{
 for(const [target,type,props]of [['button','pointerup',{pointerId:7}],['button','pointercancel',{pointerId:7}],['button','lostpointercapture',{pointerId:7}],['window','blur',{}],['button','blur',{}]]){
  const f=setup();f.fire(f.button,'pointerdown',{button:0,pointerId:7});assert(f.hold.isActive());
  f.fire(f[target],type,props);assert.equal(f.hold.isActive(),false);assert.deepEqual(f.changes,[true,false]);assert.equal(f.captures.size,0);
 }
});
test('keyboard comparison supports Space and Enter without repeats or sticking after a hidden window',()=>{
 const f=setup();
 for(const key of [' ','Enter']){
  f.fire(f.button,'keydown',{key,repeat:false});f.fire(f.button,'keydown',{key,repeat:true});assert(f.hold.isActive());
  f.fire(f.button,'keyup',{key});assert.equal(f.hold.isActive(),false);
 }
 assert.deepEqual(f.changes,[true,false,true,false]);
 f.fire(f.button,'pointerdown',{button:0,pointerId:3});f.document.hidden=true;f.fire(f.document,'visibilitychange');assert.equal(f.hold.isActive(),false);
 f.allow(false);f.fire(f.button,'pointerdown',{button:0,pointerId:9});assert.equal(f.hold.isActive(),false);
});

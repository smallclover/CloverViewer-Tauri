const assert=require('node:assert/strict'),test=require('node:test');
const {createBeautyTransaction}=require('../../.unit-test-dist/compiled/image-beautify/transaction.js');
const {emptyBeauty,beautyKey}=require('../../.unit-test-dist/compiled/image-beautify/model.js');
const {SnapshotHistory}=require('../../.unit-test-dist/compiled/image-editor/history.js');
const clone=value=>JSON.parse(JSON.stringify(value));
function setup(){
 let state={beauty:emptyBeauty(),shapes:[]},revision=0;
 const history=new SnapshotHistory(clone);
 const tx=createBeautyTransaction({capture:()=>state,clone,getRevision:()=>revision,setRevision:n=>{revision=n;},restoreBeauty:d=>{state.beauty=d;},commit:s=>history.checkpoint(s)});
 return {tx,history,get state(){return state;},get revision(){return revision;},
  edit:update=>{tx.begin();update(state.beauty);revision++;},
  undo:()=>{tx.finish();const old=history.undo(state);if(old)state=old;},redo:()=>{tx.finish();const next=history.redo(state);if(next)state=next;},
  annotate:name=>{tx.finish();history.checkpoint(state);state.shapes.push(name);revision++;},
 };
}
test('trying many frame, background and watermark changes becomes one complete undo/redo step',()=>{
 const f=setup();
 for(const kind of ['mac-light','mac-dark','gallery','wood'])f.edit(d=>{d.enabled=true;d.frame.kind=kind;});
 f.edit(d=>{d.frame.radius=25;d.watermarks=[{id:'mine',text:'signature'}];});
 assert.equal(f.history.canUndo,false);assert(f.tx.changed());
 assert.equal(f.tx.before().enabled,false);
 f.undo();assert.equal(f.state.beauty.enabled,false);assert.equal(f.state.beauty.watermarks.length,0);
 assert.equal(f.history.canUndo,false);assert(f.history.canRedo);
 f.redo();assert.equal(f.state.beauty.frame.kind,'wood');assert.equal(f.state.beauty.watermarks[0].text,'signature');
});
test('empty, reverted and visually unchanged property order rounds leave no history or dirty revision',()=>{
 const f=setup(),original=clone(f.state.beauty);
 f.tx.begin();f.tx.finish();assert.equal(f.history.canUndo,false);
 f.edit(d=>{d.enabled=true;});f.edit(d=>Object.assign(d,clone(original)));
 assert.equal(f.tx.changed(),false);f.tx.finish();assert.equal(f.revision,0);assert.equal(f.history.canUndo,false);
 f.edit(d=>{d.enabled=true;d.frame.kind='wood';});f.tx.revert();
 assert.equal(f.revision,0);assert.equal(f.history.canUndo,false);assert.deepEqual(f.state.beauty,original);
 const reordered=Object.fromEntries(Object.entries(original).reverse());assert.equal(beautyKey(reordered),beautyKey(original));
});
test('a canceled trial preserves the existing redo branch; a completed new round replaces it',()=>{
 const f=setup();f.edit(d=>{d.enabled=true;});f.tx.finish();f.undo();assert(f.history.canRedo);
 f.edit(d=>{d.frame.kind='wood';});f.tx.revert();assert(f.history.canRedo);assert.equal(f.history.canUndo,false);
 f.edit(d=>{d.enabled=true;d.frame.kind='gallery';});f.tx.finish();assert.equal(f.history.canRedo,false);
});
test('annotation boundaries and repeated visits preserve the user operation order',()=>{
 const f=setup();f.annotate('arrow');
 f.edit(d=>{d.enabled=true;d.frame.kind='mac-light';});f.edit(d=>{d.frame.kind='wood';});
 f.annotate('text');f.edit(d=>{d.frame.kind='gallery';});f.tx.finish();
 f.undo();assert.equal(f.state.beauty.frame.kind,'wood');assert.deepEqual(f.state.shapes,['arrow','text']);
 f.undo();assert.deepEqual(f.state.shapes,['arrow']);assert.equal(f.state.beauty.frame.kind,'wood');
 f.undo();assert.equal(f.state.beauty.enabled,false);assert.deepEqual(f.state.shapes,['arrow']);
 f.undo();assert.deepEqual(f.state.shapes,[]);
});
test('restoring this round retains the previously completed beautification',()=>{
 const f=setup();f.edit(d=>{d.enabled=true;d.frame.kind='gallery';});f.tx.finish();const saved=f.revision;
 f.edit(d=>{d.frame.kind='wood';});f.edit(d=>{d.frame.radius=65;});f.tx.revert();
 assert.equal(f.state.beauty.frame.kind,'gallery');assert.equal(f.state.beauty.frame.radius,16);assert.equal(f.revision,saved);
 f.undo();assert.equal(f.state.beauty.enabled,false);
});

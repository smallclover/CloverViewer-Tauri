const assert = require("node:assert/strict");
const test = require("node:test");
const { createFrameUpdate } = require("../../.unit-test-dist/image-editor/frame-update.js");

function clock() {
  let id=0;
  const callbacks=new Map();
  return {
    request: callback=>{callbacks.set(++id,callback);return id;},
    cancel: handle=>callbacks.delete(handle),
    tick: ()=>{const pending=[...callbacks.values()];callbacks.clear();pending.forEach(callback=>callback(0));},
    size: ()=>callbacks.size,
  };
}

test("a burst of crop pointer inputs paints once using only the latest coordinates", () => {
  const frames=clock(),painted=[];
  const updater=createFrameUpdate(value=>painted.push(value),frames);
  for(let i=0;i<120;i++)updater.push({x:i,y:i/2});
  assert.equal(frames.size(),1);
  assert.deepEqual(painted,[]);
  frames.tick();
  assert.deepEqual(painted,[{x:119,y:59.5}]);
  updater.push({x:120,y:60});frames.tick();
  assert.equal(painted.length,2);
});

test("pointer release flushes the exact final crop without waiting for a display frame", () => {
  const frames=clock(),painted=[];
  const updater=createFrameUpdate(value=>painted.push(value),frames);
  updater.push(1);updater.push(2);updater.flush();
  assert.deepEqual(painted,[2]);
  assert.equal(frames.size(),0);
  frames.tick();updater.flush();
  assert.deepEqual(painted,[2]);
});

test("canceling a pending drag prevents a later paint and the next drag can start normally", () => {
  const frames=clock(),painted=[];
  const updater=createFrameUpdate(value=>painted.push(value),frames);
  updater.push(1);updater.discard();frames.tick();
  assert.deepEqual(painted,[]);
  updater.push(2);frames.tick();
  assert.deepEqual(painted,[2]);
});

test("inputs queued during a paint are retained for the following display frame", () => {
  const frames=clock(),painted=[];
  const updater=createFrameUpdate(value=>{painted.push(value);if(value===1)updater.push(2);},frames);
  updater.push(1);frames.tick();
  assert.deepEqual(painted,[1]);assert.equal(frames.size(),1);
  frames.tick();assert.deepEqual(painted,[1,2]);
});

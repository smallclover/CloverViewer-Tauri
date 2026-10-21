const assert = require("node:assert/strict");
const test = require("node:test");
const {rotateShapeClockwise,shapeBBox,isShapeHit} = require("../../.unit-test-dist/compiled/image-editor/geometry.js");
const {drawAnnotation} = require("../../.unit-test-dist/compiled/image-editor/annotation-renderer.js");
const original = {tool:"text",start:{x:10,y:20},end:{x:110,y:68},text:"first\nsecond",fontSize:20,strokeWidth:2,color:"red"};
test("text rotates with its bounding box and returns exactly after four quarter turns", () => {
  let shape = original, width = 300, height = 200;
  shape = rotateShapeClockwise(shape,height); [width,height] = [height,width];
  assert.deepEqual(shapeBBox(shape), {x:132,y:10,w:48,h:100});
  assert.equal(isShapeHit(shape,{x:155,y:50},0),true);
  assert.equal(isShapeHit(shape,{x:190,y:50},0),false);
  for(let i=0;i<3;i++) {shape=rotateShapeClockwise(shape,height);[width,height]=[height,width];}
  assert.deepEqual(shape.start,original.start); assert.deepEqual(shape.end,original.end);
  assert.equal(shape.rotation,0); assert.equal(shape.text,original.text);
});
test("multiline drawing uses the same local rotation as the bounds and restores the canvas", () => {
  const calls=[];
  const context = new Proxy({}, {get: (target,key) => target[key] ?? ((...args) => calls.push([key,...args]))});
  const shape=rotateShapeClockwise(original,200); drawAnnotation(context,shape);
  assert.deepEqual(calls,[['save'],['translate',180,10],['rotate',Math.PI/2],['fillText','first',0,0],['fillText','second',0,24],['restore']]);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { cropTarget, dragCrop } = require("../../.unit-test-dist/image-editor/crop-selection.js");
const rect = { x: 100, y: 80, w: 300, h: 200 };
const bounds = { w: 640, h: 400 }, minimum = { w: 24, h: 24 };

test("crop hit testing prioritizes corners, then edges, interior and a new selection", () => {
  const targets = [[100,80,"nw"],[400,80,"ne"],[400,280,"se"],[100,280,"sw"],
    [250,80,"n"],[400,180,"e"],[250,280,"s"],[100,180,"w"],[250,180,"move"],[500,350,"new"]];
  for (const [x,y,target] of targets) assert.equal(cropTarget(rect,{x,y},{w:10,h:10}),target);
  // 容差放大到 40 像素时，左上角热区内仍优先命中角点 "nw" 而不是边 "n"。
  assert.equal(cropTarget(rect,{x:70,y:50},{w:40,h:40}),"nw");
});

test("all crop resize handles move only their own edges without jumping at grab time", () => {
  const start = { x:150, y:120 }, point = { x:170, y:130 };
  const expected = {
    nw:{x:120,y:90,w:280,h:190}, ne:{x:100,y:90,w:320,h:190},
    se:{x:100,y:80,w:320,h:210}, sw:{x:120,y:80,w:280,h:210},
    n:{x:100,y:90,w:300,h:190}, e:{x:100,y:80,w:320,h:200},
    s:{x:100,y:80,w:300,h:210}, w:{x:120,y:80,w:280,h:200},
  };
  for (const [target,result] of Object.entries(expected)) {
    assert.deepEqual(dragCrop(rect,start,start,target,bounds,minimum),rect);
    assert.deepEqual(dragCrop(rect,start,point,target,bounds,minimum),result);
  }
});

test("crop resizing stays within the image and cannot invert across the opposite corner", () => {
  assert.deepEqual(dragCrop(rect,{x:100,y:80},{x:1000,y:1000},"nw",bounds,minimum),{x:376,y:256,w:24,h:24});
  assert.deepEqual(dragCrop(rect,{x:400,y:280},{x:900,y:700},"se",bounds,minimum),{x:100,y:80,w:540,h:320});
  assert.deepEqual(dragCrop(rect,{x:100,y:80},{x:-300,y:-200},"nw",bounds,minimum),{x:0,y:0,w:400,h:280});
  const tiny={x:0,y:0,w:4,h:3};
  assert.deepEqual(dragCrop(tiny,{x:0,y:0},{x:9,y:9},"nw",{w:4,h:3},minimum),tiny);
});

test("moving a crop preserves size at every boundary and new crops normalize reverse drags", () => {
  const start={x:200,y:150};
  assert.deepEqual(dragCrop(rect,start,{x:-100,y:-100},"move",bounds,minimum),{x:0,y:0,w:300,h:200});
  assert.deepEqual(dragCrop(rect,start,{x:900,y:900},"move",bounds,minimum),{x:340,y:200,w:300,h:200});
  assert.deepEqual(dragCrop(rect,start,{x:-100,y:-100},"new",bounds,minimum),{x:0,y:0,w:200,h:150});
  assert.deepEqual(rect,{x:100,y:80,w:300,h:200});
});

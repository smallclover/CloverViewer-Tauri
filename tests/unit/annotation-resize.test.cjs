const assert=require("node:assert/strict"),test=require("node:test");
const loadTs=require("./helpers/load-ts.cjs");
const {resizeAnnotation}=loadTs("image-editor/annotation-resize.ts");
const {shapeBBox}=loadTs("image-editor/geometry.ts");
const shape={tool:"rect",start:{x:100,y:100},end:{x:300,y:200},color:"red",strokeWidth:4};
const bounds={x:0,y:0,w:1000,h:800};
test("all four resize corners keep their opposite anchor and preserve the source",()=>{
  const before=JSON.stringify(shape);
  for(const [corner,delta,expected] of [[0,{x:-20,y:-10},{x:80,y:90,w:220,h:110}],[1,{x:20,y:-10},{x:100,y:90,w:220,h:110}],[2,{x:20,y:10},{x:100,y:100,w:220,h:110}],[3,{x:-20,y:10},{x:80,y:100,w:220,h:110}]]) {
    const next=resizeAnnotation(shape,corner,delta,bounds,10);
    assert.deepEqual(JSON.parse(JSON.stringify(shapeBBox(next))),expected);
    assert.equal(next.strokeWidth,4);
  }
  assert.equal(JSON.stringify(shape),before);
  assert.equal(resizeAnnotation(shape,2,{x:0,y:0},bounds,10),shape);
});
test("resize clamps to the image, prevents corner inversion and maps every freehand point",()=>{
  const pen={...shape,tool:"pen",points:[{x:100,y:100},{x:200,y:180},{x:300,y:200}]};
  const next=resizeAnnotation(pen,2,{x:200,y:100},bounds,10);
  assert.deepEqual(JSON.parse(JSON.stringify(next.points)),[{x:100,y:100},{x:300,y:260},{x:500,y:300}]);
  const small=resizeAnnotation(shape,0,{x:1000,y:1000},bounds,10);
  assert.equal(shapeBBox(small).w,10);assert.equal(shapeBBox(small).h,10);
  const big=resizeAnnotation(shape,2,{x:10000,y:10000},bounds,10);
  assert.equal(big.end.x,1000);assert.equal(big.end.y,800);
  for(const arrow of [{...shape,tool:"arrow",end:{x:300,y:100}},{...shape,tool:"arrow",end:{x:100,y:300}}]) {
    const resized=resizeAnnotation(arrow,2,{x:50,y:50},bounds,2);
    assert.ok(Number.isFinite(resized.end.x)&&Number.isFinite(resized.end.y));
  }
});
test("rotated text scales uniformly with its font and mosaic resizes its brush footprint",()=>{
  const text={...shape,tool:"text",start:{x:300,y:100},end:{x:200,y:300},rotation:90,fontSize:100,text:"keep"};
  const next=resizeAnnotation(text,2,{x:100,y:100},bounds,10);
  assert.equal(next.rotation,90);assert.equal(next.fontSize,200);
  assert.equal(shapeBBox(next).w,200);assert.equal(shapeBBox(next).h,400);
  const mosaic=resizeAnnotation({...shape,tool:"mosaic",blockSize:20},2,{x:200,y:100},bounds,10);
  assert.equal(mosaic.blockSize,40);
});

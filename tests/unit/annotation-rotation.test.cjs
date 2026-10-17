const assert=require("node:assert/strict"),test=require("node:test");
const loadTs=require("./helpers/load-ts.cjs");
const {rotateAnnotation}=loadTs("image-editor/annotation-rotation.ts");
const {shapeBBox,rotateVector,isShapeHit,rotateShapeClockwise}=loadTs("image-editor/geometry.ts");
const {drawAnnotation}=loadTs("image-editor/annotation-renderer.ts");
const {resizeAnnotation}=loadTs("image-editor/annotation-resize.ts");
const rect={tool:"rect",start:{x:200,y:200},end:{x:400,y:300},strokeWidth:4,color:"red"};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test("rotation preserves every annotation's center, dimensions and source data",()=>{
  for(const tool of ["rect","circle","arrow","pen","mosaic","text"]) {
    const original={...rect,tool,fontSize:40,text:"keep",blockSize:20,...(tool==="pen"||tool==="mosaic"?{points:[rect.start,{x:300,y:250},rect.end]}:{})};
    const saved=JSON.stringify(original),next=rotateAnnotation(original,90);
    const before=shapeBBox(original),after=shapeBBox(next);
    near(before.x+before.w/2,after.x+after.w/2);near(before.y+before.h/2,after.y+after.h/2);
    near(after.w,before.h);near(after.h,before.w);
    assert.equal(next.fontSize,40);assert.equal(next.blockSize,20);assert.equal(next.text,"keep");
    assert.equal(JSON.stringify(original),saved);assert.equal(rotateAnnotation(original,360),original);
    assert.equal(rotateAnnotation(original,NaN),original);
    if(original.points) {near(next.points[1].x,300);near(next.points[1].y,250);}
  }
});

test("asymmetric strokes keep one origin across repeated rotations instead of following their changing bounds",()=>{
  const original={...rect,tool:"pen",start:{x:100,y:100},end:{x:100,y:300},points:[{x:100,y:100},{x:400,y:100},{x:100,y:300}]};
  const first=rotateAnnotation(original,45),second=rotateAnnotation(first,45),direct=rotateAnnotation(original,90);
  const b=shapeBBox(first);assert.ok(Math.abs(b.y+b.h/2-first.rotationOrigin.y)>10,"regression requires an asymmetric stroke");
  near(first.rotationOrigin.x,250);near(first.rotationOrigin.y,200);
  near(second.rotationOrigin.x,250);near(second.rotationOrigin.y,200);
  second.points.forEach((p,i)=>{near(p.x,direct.points[i].x);near(p.y,direct.points[i].y);});
});

test("an explicit point is the invariant anchor and follows moving, resizing and whole-image rotation",()=>{
  const {cloneShape,translateShape}=loadTs("image-editor/geometry.ts");
  const original={...rect,rotationOrigin:{...rect.start}},next=rotateAnnotation(original,73);
  near(next.start.x,rect.start.x);near(next.start.y,rect.start.y);
  assert.deepEqual(JSON.parse(JSON.stringify(next.rotationOrigin)),rect.start);
  const copy=cloneShape(next);translateShape(copy,20,30);
  near(copy.rotationOrigin.x,220);near(copy.rotationOrigin.y,230);near(next.rotationOrigin.x,200);
  const turned=rotateShapeClockwise(copy,800);near(turned.rotationOrigin.x,570);near(turned.rotationOrigin.y,220);
  const scaled=resizeAnnotation(original,2,{x:200,y:100},{x:0,y:0,w:1000,h:800},10);
  near(scaled.rotationOrigin.x,200);near(scaled.rotationOrigin.y,200);
});
test("arbitrary rectangle and text rotation shares exact bounds and local hit testing",()=>{
  for(const tool of ["rect","text"]) {
    const next=rotateAnnotation({...rect,tool,text:"hello",fontSize:40},45),box=shapeBBox(next);
    near(box.w,300/Math.sqrt(2));near(box.h,300/Math.sqrt(2));
    assert.equal(isShapeHit(next,{x:300,y:250},0),true);
    assert.equal(isShapeHit(next,{x:box.x,y:box.y},0),false);
  }
});
test("rotated ellipse bounds match its axes and hits follow the rotated outline",()=>{
  const next=rotateAnnotation({...rect,tool:"circle"},37),box=shapeBBox(next),angle=37*Math.PI/180;
  near(box.w,2*Math.hypot(100*Math.cos(angle),50*Math.sin(angle)));
  near(box.h,2*Math.hypot(100*Math.sin(angle),50*Math.cos(angle)));
  const edge=rotateVector({x:100,y:0},37);
  assert.equal(isShapeHit(next,{x:300+edge.x,y:250+edge.y},.001),true);
  assert.equal(isShapeHit(next,{x:box.x,y:box.y},.1),false);
});
test("whole-image quarter turns compose with arbitrary annotation rotation",()=>{
  for(const tool of ["rect","circle","text"]) {
    const before=rotateAnnotation({...rect,tool,text:"keep",fontSize:40},37);let next=before,w=1000,h=800;
    for(let i=0;i<4;i++){next=rotateShapeClockwise(next,h);[w,h]=[h,w];}
    near(next.start.x,before.start.x);near(next.start.y,before.start.y);near(next.end.x,before.end.x);near(next.end.y,before.end.y);
    near(next.rotation,before.rotation);
    const a=shapeBBox(next),b=shapeBBox(before);for(const key of ["x","y","w","h"])near(a[key],b[key]);
  }
});
test("rotated rectangle and ellipse draw in local coordinates and restore the context",()=>{
  for(const tool of ["rect","circle"]) {
    const calls=[];const context=new Proxy({}, {get:(obj,key)=>obj[key]??((...args)=>calls.push([key,...args]))});
    const next=rotateAnnotation({...rect,tool},37);drawAnnotation(context,next);
    assert.equal(calls[0][0],"save");assert.equal(calls[1][0],"translate");near(calls[2][1],37*Math.PI/180);
    const draw=calls.find(call=>call[0]===(tool==="rect"?"strokeRect":"ellipse"));
    if(tool==="rect"){near(draw[1],0);near(draw[2],0);near(draw[3],200);near(draw[4],100);}
    else {near(draw[1],100);near(draw[2],50);near(draw[3],100);near(draw[4],50);}
    assert.equal(calls.at(-1)[0],"restore");
  }
});
test("resizing rotated local shapes remains uniform and preserves their rotation",()=>{
  for(const tool of ["rect","circle","text"]) {
    const before=rotateAnnotation({...rect,tool,text:"keep",fontSize:40},37);
    const a=shapeBBox(before),next=resizeAnnotation(before,2,{x:100,y:50},{x:0,y:0,w:1000,h:800},10),b=shapeBBox(next);
    near(b.w/a.w,b.h/a.h);near(next.rotation,37);
    const offset=tool==="circle"?rotateVector({x:100*b.w/a.w,y:0},37):{x:0,y:0};
    assert.equal(isShapeHit(next,{x:b.x+b.w/2+offset.x,y:b.y+b.h/2+offset.y},.001),true);
  }
});

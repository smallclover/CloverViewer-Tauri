const assert=require("node:assert/strict"),test=require("node:test");
const loadTs=require("./helpers/load-ts.cjs");
const {annotationFrame}=loadTs("image-editor/annotation-frame.ts");
const {rotateAnnotation}=loadTs("image-editor/annotation-rotation.ts");
const {rotateShapeClockwise,translateShape}=loadTs("image-editor/geometry.ts");
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test("oriented frames retain width and height and every corner follows the same rigid rotation",()=>{
  for(const tool of ["rect","circle","arrow","pen","mosaic","text"]) {
    const original={tool,start:{x:100,y:100},end:{x:100,y:300},color:"red",strokeWidth:4,
      ...(tool==="pen"||tool==="mosaic"?{points:[{x:100,y:100},{x:400,y:100},{x:100,y:300}]}:{end:{x:400,y:300}})};
    const before=annotationFrame(original);
    let next=original;
    for(const angle of [37,45,-62,90]) {
      next=rotateAnnotation(next,angle);const after=annotationFrame(next);
      near(after.w,before.w);near(after.h,before.h);
      const o=next.rotationOrigin;
      before.corners.forEach((point,i)=>near(Math.hypot(point.x-o.x,point.y-o.y),Math.hypot(after.corners[i].x-o.x,after.corners[i].y-o.y)));
    }
    translateShape(next,20,30);const moved=annotationFrame(next);
    next=rotateShapeClockwise(next,800);const turned=annotationFrame(next);
    near(turned.w,before.w);near(turned.h,before.h);
    turned.corners.forEach((p,i)=>{near(p.x,800-moved.corners[i].y);near(p.y,moved.corners[i].x);});
  }
});

test("whole-image rotation retains the frame direction when the saved annotation angle is zero",()=>{
  for(const tool of ["rect","circle","arrow","pen","mosaic","text"]) {
    const shape={tool,start:{x:100,y:100},end:{x:400,y:300},color:"red",strokeWidth:4};
    const zero=rotateAnnotation(rotateAnnotation(shape,37),-37),before=annotationFrame(zero);
    near(zero.rotation,0);
    const turned=annotationFrame(rotateShapeClockwise(zero,800));
    near(turned.angle,90);near(turned.w,before.w);near(turned.h,before.h);
    turned.corners.forEach((p,i)=>{near(p.x,800-before.corners[i].y);near(p.y,before.corners[i].x);});
  }
});

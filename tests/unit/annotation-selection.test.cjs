const assert=require("node:assert/strict");
const test=require("node:test");
const loadTs=require("./helpers/load-ts.cjs");

function setup(shapes,bounds={x:0,y:0,w:2000,h:1000},scale=.2) {
  const nodes=[],frames=new Map(),commits=[];let serial=0,selected=false;
  const box={left:50,top:40,width:2000*scale,height:1000*scale};
  const canvas={width:2000,height:1000,style:{},getBoundingClientRect:()=>box,setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
  const surface={append:node=>nodes.push(node),getBoundingClientRect:()=>({left:0,top:0})};
  const {createAnnotationSelection}=loadTs("image-editor/annotation-selection.ts",{}, {
    document:{createElement:()=>{const handlers={};return {style:{},children:[],append(node){this.children.push(node);},addEventListener:(name,handler)=>{handlers[name]=handler;},fire:(name,event)=>handlers[name]?.(event)};}},
    requestAnimationFrame:fn=>{frames.set(++serial,fn);return serial;},cancelAnimationFrame:id=>frames.delete(id),
  });
  const selection=createAnnotationSelection({canvas,surface,translate:key=>key,isActive:()=>true,getShapes:()=>shapes,getBounds:()=>bounds,
    replace:(index,shape)=>{shapes[index]=shape;},commit:(index,before)=>commits.push({index,before}),
    select:value=>{selected=value;},render:()=>selection.refresh(),
  });
  const event=(x,y,id=1)=>({clientX:50+x*scale,clientY:40+y*scale,pointerId:id,button:0,preventDefault(){},stopPropagation(){}});
  return {selection,event,shapes,commits,nodes,canvas,selected:()=>selected,
    frame:()=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());}};
}
const shape=tool=>({tool,start:{x:500,y:300},end:{x:900,y:600},color:"#f00",strokeWidth:10,
  ...(tool==="text"?{text:"keep",rotation:90,fontSize:100}:{}),
  ...(tool==="pen"||tool==="mosaic"?{points:[{x:500,y:300},{x:900,y:600}],blockSize:32}:{}),
});

test("selection translates adjustable annotations from the final release as one edit",()=>{
  for(const tool of ["rect","circle","arrow","text"]) {
    const original=shape(tool),before=JSON.stringify(original),f=setup([original]);
    const point=tool==="circle"?{x:700,y:300}:original.start;
    f.selection.down(f.event(point.x,point.y));
    f.selection.move(f.event(point.x+20,point.y+20));
    f.selection.up(f.event(point.x+100,point.y+50));
    assert.equal(f.shapes[0].start.x,600,tool);assert.equal(f.shapes[0].start.y,350,tool);
    assert.equal(f.shapes[0].end.x,1000);assert.equal(f.shapes[0].end.y,650);
    if(original.points)assert.deepEqual(JSON.parse(JSON.stringify(f.shapes[0].points)),[{x:600,y:350},{x:1000,y:650}]);
    assert.equal(f.shapes[0].rotation,original.rotation);
    assert.equal(f.commits.length,1);assert.equal(JSON.stringify(f.commits[0].before),before);
    assert.equal(JSON.stringify(original),before,"the original shape is isolated");
    f.frame();assert.equal(f.commits.length,1,"no queued movement after release");
  }
});

test("selection uses screen-sized hit tolerance, chooses the topmost annotation and clamps movement to the crop",()=>{
  const f=setup([shape("arrow"),shape("arrow")],{x:400,y:200,w:800,h:600});
  f.selection.down(f.event(500,275)); // 5 CSS pixels from the stroke.
  assert.equal(f.selection.selected,1);
  f.selection.up(f.event(1900,950));
  assert.equal(f.shapes[1].end.x,1200);assert.equal(f.shapes[1].end.y,800);
  assert.equal(f.shapes[0].start.x,500);
  assert.equal(f.nodes[0].hidden,false);
  f.selection.down(f.event(100,100));assert.equal(f.selected(),false);
  assert.equal(f.nodes[0].hidden,true);
});

test("clicks and a drag returning to its origin create no edit; cancel restores position and discards queued input",()=>{
  const f=setup([shape("arrow")]);
  f.selection.down(f.event(500,300));f.selection.up(f.event(505,300));
  assert.equal(f.commits.length,0);
  f.selection.down(f.event(500,300));f.selection.move(f.event(600,400));f.frame();
  assert.equal(f.shapes[0].start.x,600);
  f.selection.move(f.event(700,500));f.selection.cancel();f.frame();
  assert.equal(f.shapes[0].start.x,500);assert.equal(f.commits.length,0);
  f.selection.up(f.event(900,600));assert.equal(f.shapes[0].start.x,500);
  f.selection.down(f.event(500,300));f.selection.move(f.event(600,400));f.frame();
  f.selection.up(f.event(500,300));assert.equal(f.commits.length,0);
  assert.equal(f.shapes[0].start.x,500);
});



const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7, a+" != "+b);
const json=value=>JSON.parse(JSON.stringify(value));
const select=f=>{f.selection.down(f.event(500,300));f.selection.up(f.event(500,300));};
const {annotationFrame,annotationRotationCursor}=loadTs("image-editor/annotation-frame.ts");
const {annotationRotationOrigin}=loadTs("image-editor/annotation-rotation.ts");
const cornerStart=(f,corner)=>{const p=annotationFrame(f.shapes[0]).corners[corner];return f.event(p.x,p.y);};
const turn=(f,start,degrees)=>{
  const p=annotationRotationOrigin(f.shapes[0]),center=f.event(p.x,p.y),a=degrees*Math.PI/180;
  const x=start.clientX-center.clientX,y=start.clientY-center.clientY;
  return {...start,clientX:center.clientX+x*Math.cos(a)-y*Math.sin(a),clientY:center.clientY+x*Math.sin(a)+y*Math.cos(a)};
};

test("all four corners follow pointer direction around a fixed center at every preview zoom",()=>{
  for(const scale of [.1,.2,1,2])for(let corner=0;corner<4;corner++) {
    const f=setup([shape("rect")],undefined,scale);select(f);
    const handle=f.nodes[0].children[corner],start=cornerStart(f,corner),end=turn(f,start,90);
    handle.fire("pointerdown",start);
    assert.match(f.canvas.style.cursor,/data:image\/svg\+xml/);
    const cursor=f.canvas.style.cursor,pivot=f.nodes[2],position={...pivot.style};
    f.selection.move({...end,pointerId:2});f.frame();assert.equal(f.shapes[0].rotation,undefined);
    f.selection.move(turn(f,start,30));f.frame();
    assert.notEqual(f.canvas.style.cursor,cursor,"the cursor follows the rotating corner during the gesture");
    assert.equal(f.canvas.style.cursor,annotationRotationCursor(30+corner*90));
    f.selection.up(end);
    const next=f.shapes[0];near(next.rotation,90);near(next.start.x,850);near(next.start.y,250);
    near(next.end.x,550);near(next.end.y,650);
    assert.deepEqual(json(next.rotationOrigin),{x:700,y:450});
    assert.deepEqual(pivot.style,position);assert.equal(f.commits.length,1);
    f.frame();assert.equal(f.commits.length,1);
  }
});

test("horizontal and vertical corner drags both rotate rectangles in the direction of the pointer",()=>{
  for(let corner=0;corner<4;corner++)for(const axis of ["clientX","clientY"]) {
    const f=setup([shape("rect")]);select(f);const start=cornerStart(f,corner);
    const end={...start,[axis]:start[axis]+35};f.nodes[0].children[corner].fire("pointerdown",start);f.selection.up(end);
    assert.ok(f.shapes[0].rotation>0,"no horizontal or vertical dead direction");
    const center=f.event(700,450),a=Math.atan2(start.clientY-center.clientY,start.clientX-center.clientX),b=Math.atan2(end.clientY-center.clientY,end.clientX-center.clientX);
    near(f.shapes[0].rotation,((b-a)*180/Math.PI+360)%360);
    assert.equal(f.commits.length,1);
  }
});

test("corner rotation is rigid for adjustable annotations and keeps style sizes",()=>{
  const {shapeBBox}=loadTs("image-editor/geometry.ts");
  for(const tool of ["rect","circle","arrow","text"]) {
    const original=shape(tool),f=setup([original]);f.selection.focus(0);
    const b=shapeBBox(original),center={x:b.x+b.w/2,y:b.y+b.h/2};
    const start=cornerStart(f,0);f.nodes[0].children[0].fire("pointerdown",start);f.selection.up(turn(f,start,-37));
    const next=f.shapes[0];
    for(const key of ["strokeWidth","fontSize","blockSize","text"])assert.equal(next[key],original[key]);
    const before=[original.start,original.end,...(original.points??[])],after=[next.start,next.end,...(next.points??[])];
    before.forEach((point,i)=>{
      near(Math.hypot(point.x-center.x,point.y-center.y),Math.hypot(after[i].x-center.x,after[i].y-center.y));
      before.forEach((other,j)=>near(Math.hypot(point.x-other.x,point.y-other.y),Math.hypot(after[i].x-after[j].x,after[i].y-after[j].y)));
    });
    assert.equal(f.commits.length,1);
  }
});

test("rotation clicks, radial movement, returning to the start and full turns create no edit",()=>{
  for(const mode of ["click","radial","return","full"]) {
    const f=setup([shape("rect")]);select(f);const before=JSON.stringify(f.shapes[0]),start=cornerStart(f,2);
    f.nodes[0].children[2].fire("pointerdown",start);
    if(mode==="return"){f.selection.move(turn(f,start,45));f.frame();}
    if(mode==="full")for(const a of [90,180,270]){f.selection.move(turn(f,start,a));f.frame();}
    let end=start;
    if(mode==="radial"){const c=f.event(700,450);end={...start,clientX:c.clientX+(start.clientX-c.clientX)*2,clientY:c.clientY+(start.clientY-c.clientY)*2};}
    f.selection.up(end);
    assert.equal(f.commits.length,0,mode);assert.equal(JSON.stringify(f.shapes[0]),before,mode);
  }
});

test("consecutive gestures keep the center and cancellation restores the last rotation",()=>{
  const f=setup([shape("rect")]);select(f);const handle=f.nodes[0].children[2];
  for(let i=0;i<2;i++) {const start=cornerStart(f,2);handle.fire("pointerdown",start);f.selection.up(turn(f,start,45));}
  near(f.shapes[0].rotation,90);near(f.shapes[0].start.x,850);near(f.shapes[0].start.y,250);
  assert.equal(f.commits.length,2);const saved=JSON.stringify(f.shapes[0]),start=cornerStart(f,2);
  handle.fire("pointerdown",start);f.selection.move(turn(f,start,-70));f.frame();
  f.selection.move(turn(f,start,-100));f.selection.cancel();f.frame();f.selection.up(start);
  assert.equal(JSON.stringify(f.shapes[0]),saved);assert.equal(f.commits.length,2);
});

test("crossing the angle seam stays continuous and entering the center does not flip the shape",()=>{
  const f=setup([shape("rect")]);select(f);const start=cornerStart(f,0);f.nodes[0].children[0].fire("pointerdown",start);
  for(const a of [-40,-50,-80]){f.selection.move(turn(f,start,a));f.frame();near(f.shapes[0].rotation,(a+360)%360);}
  const center=f.event(700,450);f.selection.move(center);f.frame();near(f.shapes[0].rotation,280);
  const opposite=turn(f,start,180);f.selection.move(opposite);f.frame();near(f.shapes[0].rotation,280);
  f.selection.up(opposite);assert.equal(f.commits.length,1);
});

test("the frame rotates rigidly, and corner cursors match its direction",()=>{
  for(const tool of ["rect","circle","arrow","text"]) {
    const f=setup([shape(tool)]);f.selection.focus(0);const outline=f.nodes[0],before={...outline.style};
    const cursors=outline.children.map(node=>node.style.cursor);assert.equal(new Set(cursors).size,4);
    const start=cornerStart(f,1);outline.children[1].fire("pointerdown",start);f.selection.up(turn(f,start,37));
    near(parseFloat(outline.style.width),parseFloat(before.width));near(parseFloat(outline.style.height),parseFloat(before.height));
    assert.notEqual(outline.style.transform,before.transform);
    outline.children.forEach((node,i)=>assert.equal(node.style.cursor,annotationRotationCursor(f.shapes[0].rotation+i*90)));
    assert.equal(f.canvas.style.cursor,"default");
  }
});

test("pen and mosaic remain fixed through hover, drag, focus and corner gestures",()=>{
  for(const tool of ["pen","mosaic"]) {
    const f=setup([shape(tool)]),before=JSON.stringify(f.shapes);
    f.selection.move(f.event(500,300));
    assert.equal(f.nodes[1].hidden,true,"fixed strokes have no hover outline");
    assert.equal(f.canvas.style.cursor,"default");
    f.selection.down(f.event(500,300));f.selection.move(f.event(600,400));
    f.selection.up(f.event(700,500));f.frame();
    assert.equal(f.selection.selected,null);
    f.selection.focus(0);assert.equal(f.selection.selected,null);
    assert.equal(f.nodes[0].hidden,true);assert.equal(f.nodes[2].hidden,true);
    f.nodes[0].children[0].fire("pointerdown",f.event(500,300));
    f.selection.up(f.event(900,600));
    assert.equal(f.selected(),false);assert.equal(f.commits.length,0);
    assert.equal(JSON.stringify(f.shapes),before);
  }
});

test("fixed strokes do not intercept selection of an adjustable annotation underneath",()=>{
  const f=setup([shape("arrow"),shape("pen"),shape("mosaic")]);
  const before=JSON.stringify(f.shapes.slice(1));
  f.selection.down(f.event(500,300));assert.equal(f.selection.selected,0);
  f.selection.up(f.event(600,350));
  assert.equal(f.shapes[0].start.x,600);assert.equal(f.shapes[0].start.y,350);
  assert.equal(JSON.stringify(f.shapes.slice(1)),before);assert.equal(f.commits.length,1);
});

test("the grabbed corner cursor keeps its concave side inward throughout rotation and cancellation",()=>{
  for(let corner=0;corner<4;corner++) {
    const f=setup([shape("rect")]);f.selection.focus(0);const handle=f.nodes[0].children[corner],start=cornerStart(f,corner);
    handle.fire("pointerdown",start);
    for(const angle of [7,19,37,89,137,179,223,271,317,359]) {
      f.selection.move(turn(f,start,angle));f.frame();
      const svg=decodeURIComponent(f.canvas.style.cursor.match(/data:image\/svg\+xml,([^"']+)/)[1]);
      const direction=Number(svg.match(/rotate\((\d+) 16 16\)/)[1]);
      near(direction,(angle+corner*90)%360);
      assert.equal(f.canvas.style.cursor,handle.style.cursor,"captured canvas uses the current corner direction");
    }
    f.selection.cancel();
    assert.equal(handle.style.cursor,annotationRotationCursor(corner*90));
    assert.equal(f.commits.length,0);
  }
});

test("rotated frame clipping follows the crop in local coordinates and hides corners outside it",()=>{
  const {rotateAnnotation}=loadTs("image-editor/annotation-rotation.ts");
  const {rotateVector}=loadTs("image-editor/geometry.ts");
  const {annotationFrame}=loadTs("image-editor/annotation-frame.ts");
  const crop={x:600,y:300,w:250,h:250},shape=rotateAnnotation({tool:"rect",start:{x:500,y:300},end:{x:900,y:600},strokeWidth:10,color:"red"},37);
  const f=setup([shape],crop);f.selection.focus(0);const box=annotationFrame(shape);
  const numbers=f.nodes[0].style.clipPath.match(/-?[\d.]+/g).map(Number);
  for(let i=0;i<4;i++) {
    const p=rotateVector({x:box.x-25+numbers[i*2]/.2,y:box.y-25+numbers[i*2+1]/.2},37);
    near(p.x,i===1||i===2?850:600);near(p.y,i>=2?550:300);
    const c=box.corners[i];
    assert.equal(f.nodes[0].children[i].hidden,c.x<600||c.x>850||c.y<300||c.y>550);
  }
});

const assert=require("node:assert/strict");
const test=require("node:test");
const loadTs=require("./helpers/load-ts.cjs");

test("viewport pan owns one pointer and reset or blur releases its capture", () => {
  for (const ending of ["pointercancel", "lostpointercapture", "blur", "reset"]) {
    const events = new Map(), windowEvents = new Map(), captured = new Set(), moves = [];
    const {bindEditorViewportInput} = loadTs("image-editor/viewport-input.ts", {}, {
      window: {addEventListener: (name, handler) => windowEvents.set(name, handler)},
    });
    const surface = {
      classList: {add() {}, remove() {}}, addEventListener: (name, handler) => events.set(name, handler),
      setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
      releasePointerCapture: id => { captured.delete(id); events.get("lostpointercapture")({pointerId: id}); },
    };
    const input = bindEditorViewportInput({surface, viewport: {panBy: (x,y) => moves.push([x,y])},
      isActive: () => true, isBusy: () => false});
    const event = (id, x, y) => ({pointerId: id, button: 1, clientX: x, clientY: y, preventDefault() {}, stopImmediatePropagation() {}});
    events.get("pointerdown")(event(1, 10, 20));
    events.get("pointerdown")(event(2, 500, 500));
    events.get("pointercancel")(event(2, 500, 500));
    events.get("lostpointercapture")(event(2, 500, 500));
    events.get("pointermove")(event(1, 20, 40));
    assert.deepEqual(moves, [[10, 20]]);
    if (ending === "reset") input.reset();
    else if (ending === "blur") windowEvents.get("blur")();
    else events.get(ending)(event(1, 20, 40));
    assert.equal(captured.size, 0, ending);
    events.get("pointerup")(event(1, 100, 100));
    assert.deepEqual(moves, [[10, 20]], "late release cannot move the viewport");
  }
});
test("wheel zoom and Space/middle-button panning use CSS coordinates without starting annotations", () => {
  const events=new Map(),windowEvents=new Map(),calls=[];let busy=false,cropping=false;
  const {bindEditorViewportInput}=loadTs("image-editor/viewport-input.ts",{}, {window:{addEventListener:(name,handler)=>windowEvents.set(name,handler)}});
  const surface={classList:{add(){},remove(){}},addEventListener:(name,handler)=>events.set(name,handler),getBoundingClientRect:()=>({left:20,top:30}),setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
  const viewport={zoomBy:(factor,anchor)=>calls.push({factor,anchor}),panBy:(x,y)=>calls.push({x,y}),fitImage:()=>calls.push("fit"),actualSize:()=>calls.push("actual")};
  bindEditorViewportInput({surface,viewport,isActive:()=>true,isBusy:()=>busy,isCropping:()=>cropping});
  const event=(extra={})=>({pointerId:1,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra});
  events.get("wheel")(event({deltaY:-100,clientX:120,clientY:130}));
  assert.deepEqual({...calls[0].anchor},{x:100,y:100});
  windowEvents.get("keydown")(event({key:" "}));
  const down=event({button:0,clientX:50,clientY:60});events.get("pointerdown")(down);assert.equal(down.stopped,true);
  events.get("pointermove")(event({clientX:60,clientY:70}));events.get("pointerup")(event({clientX:65,clientY:75}));
  assert.deepEqual(calls.slice(1),[{x:10,y:10},{x:5,y:5}]);
  busy=true;events.get("wheel")(event({deltaY:100,clientX:0,clientY:0}));assert.equal(calls.length,3);
  windowEvents.get("keydown")(event({key:"0"}));assert.equal(calls.length,3);
  busy=false;
  windowEvents.get("keydown")(event({key:"0"}));
  windowEvents.get("keydown")(event({key:"1"}));
  assert.deepEqual(calls.slice(3),["fit","actual"]);
  cropping=true;
  const actual=event({key:"1"});windowEvents.get("keydown")(actual);
  assert.equal(actual.prevented,undefined);
  windowEvents.get("keydown")(event({key:"0"}));
  assert.deepEqual(calls.slice(3),["fit","actual","fit"]);
});

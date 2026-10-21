const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {resolve = ok; reject = fail;});
  return {promise, resolve, reject};
};
const info = id => ({share_id:id,url:`http://example.test/${id}`,qr_code:"data:image/png;base64,AA==",expires_in_seconds:60,download_limit:1});

async function fixture(kind) {
  const intervals = new Map(), timers = new Map(), stopIds = [];
  let timerId = 0, now = 0, status = true, stopResponse = () => Promise.resolve(), currentInfo, shareCalls = 0;
  function element(tag) {
    const handlers = new Map(), classes = new Set();
    return {
      tag, children:[], dataset:{}, style:{}, textContent:"", disabled:false, offsetWidth:260,offsetHeight:400,
      classList:{add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name))},
      append(...nodes) {this.children.push(...nodes);}, replaceChildren(...nodes) {this.children=nodes;},
      setAttribute() {}, addEventListener:(name,handler)=>handlers.set(name,handler),
      click:()=>handlers.get("click")?.({stopPropagation(){}}),
    };
  }
  const window = {
    setInterval:fn=>{intervals.set(++timerId,fn);return timerId;},clearInterval:id=>intervals.delete(id),
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
  };
  const globals = {document:{createElement:element},window,Date:{now:()=>now}};
  const read = () => status instanceof Error ? Promise.reject(status) : Promise.resolve(status);
  const stop = id => {stopIds.push(id);return stopResponse();};
  const root = element("div");
  let open, panel;
  if (kind === "viewer") {
    const {createImageShareController}=loadTs("viewer/image-share-controller.ts",{"../ui/icons":{uiIcon:()=>""}},globals);
    const controller=createImageShareController({panel:root,startLanShare:async()=>{shareCalls++;return currentInfo;},copyText:async()=>{},stopLanShare:stop,isLanShareActive:read,translate:key=>key,onClose(){}});
    panel=root;
    open=async value=>{currentInfo=value;controller.open({path:"photo.png",name:"photo.png"});await flush();};
  } else {
    const {createLanSharePanel}=loadTs("screenshot/lan-share-panel.ts",{
      "../i18n":{t:key=>key},"../api":{isLanShareActive:read},"./icons":{makeBtn:()=>element("button")},
    },globals);
    const controller=createLanSharePanel({uiLayer:root,onCopy:async()=>{},onStop:stop});
    panel=root.children[0];
    open=async value=>{controller.show(value,()=>({x:20,y:20}));await flush();};
  }
  const nodes = node => [node,...(node.children??[]).filter(child=>typeof child!=="string").flatMap(nodes)];
  const text = node => (node.textContent??"")+(node.children??[]).map(child=>typeof child==="string"?child:text(child)).join("");
  const button = key => nodes(panel).find(node=>node.tag==="button"&&text(node).includes(key));
  const f={open,panel,button,text:()=>text(panel),nodes:()=>nodes(panel),stopIds,
    shareResponse:value=>{currentInfo=value;},shareCalls:()=>shareCalls,
    status:value=>{status=value;},stopResponse:value=>{stopResponse=value;},time:value=>{now=value;},
    tick:async()=>{[...intervals.values()].forEach(fn=>fn());await flush();},intervals};
  await open(info("one"));
  return f;
}

for (const kind of ["viewer","screenshot"]) {
  const stopKey=kind==="viewer"?"prop.shareStop":"shot.shareStop";
  const expired=kind==="viewer"?/prop.shareExpired/:/shot.shareExpired/;
  test(`${kind}: download invalidation removes the QR/link and expires the panel before its countdown`,async()=>{
    const f=await fixture(kind);f.status(false);await f.tick();
    assert.match(f.text(),expired);
    assert.ok(f.nodes().filter(node=>node.tag==="img"||node.tag==="code").every(node=>node.hidden));
    assert.equal(f.intervals.size,0);
  });
  test(`${kind}: stop waits for confirmation, keeps polling after failure and expires on backend invalidation`,async()=>{
    const f=await fixture(kind), pending=deferred();f.stopResponse(()=>pending.promise);
    const stop=f.button(stopKey);stop.click();
    assert.match(f.text(),/shot.shareStopping/);assert.equal(stop.disabled,true);
    assert.doesNotMatch(f.text(),/shot.shareStopped|prop.shareStopped/);
    assert.deepEqual(f.stopIds,["one"]);
    pending.reject(Error("denied"));await flush();
    assert.equal(stop.disabled,false);assert.match(f.text(),/shot.shareStopFailed/);
    assert.ok(f.intervals.size>0);
    f.status(false);await f.tick();assert.match(f.text(),expired);
  });
  test(`${kind}: confirmed stop displays an expired state and deactivates the share controls`,async()=>{
    const f=await fixture(kind);f.button(stopKey).click();await flush();
    assert.match(f.text(),expired);
    assert.equal(f.intervals.size,0);
    assert.ok(f.nodes().filter(node=>node.tag==="img"||node.tag==="code").every(node=>node.hidden));
    assert.ok(f.nodes().filter(node=>node.tag==="button"&&/shareCopy|shareStop/.test(node.textContent)).every(node=>node.disabled));
  });
  test(`${kind}: query failures display an unknown state, recover, and still expire at the time limit`,async()=>{
    const f=await fixture(kind);f.status(Error("IPC unavailable"));await f.tick();
    assert.match(f.text(),/shot.shareStatusUnavailable/);assert.doesNotMatch(f.text(),expired);
    f.status(true);await f.tick();
    assert.doesNotMatch(f.text(),/shot.shareStatusUnavailable/);assert.match(f.text(),/shareExpires/);
    f.time(60000);await f.tick();assert.match(f.text(),expired);
  });
  test(`${kind}: a late stop result cannot replace a newly generated share`,async()=>{
    const f=await fixture(kind),pending=deferred();f.stopResponse(()=>pending.promise);
    f.button(stopKey).click();await f.open(info("two"));
    pending.resolve();await flush();
    assert.doesNotMatch(f.text(),expired);assert.doesNotMatch(f.text(),/shot.shareStopping/);
    assert.match(f.text(),/example.test\/two/);assert.ok(f.intervals.size>0);
  });
  test(`${kind}: a stalled status request stops claiming a confirmed countdown and can recover`,async()=>{
    const f=await fixture(kind),pending=deferred();f.status(pending.promise);await f.tick();
    f.time(5000);await f.tick();assert.match(f.text(),/shot.shareStatusUnavailable/);
    pending.resolve(true);await flush();
    assert.doesNotMatch(f.text(),/shot.shareStatusUnavailable/);assert.match(f.text(),/shareExpires/);
  });
}

test("viewer: sharing again shows disabled progress, then allows retrying a failed generation",async()=>{
  const f=await fixture("viewer");f.status(false);await f.tick();
  const pending=deferred();f.shareResponse(pending.promise);
  f.button("prop.shareAgain").click();
  assert.match(f.text(),/prop.sharePreparing/);
  assert.doesNotMatch(f.text(),/prop.shareExpired/);
  const generating=f.button("prop.shareGenerating");
  assert.equal(generating.disabled,true);
  generating.click();assert.equal(f.shareCalls(),2);
  pending.reject(Error("connection refused"));await flush();
  assert.match(f.text(),/prop.shareFailed/);
  assert.equal(f.button("prop.shareRetry").disabled,false);
  f.status(true);f.shareResponse(info("renewed"));
  f.button("prop.shareRetry").click();await flush();
  assert.match(f.text(),/example.test\/renewed/);
  assert.doesNotMatch(f.text(),/prop.shareFailed|prop.sharePreparing/);
  assert.equal(f.button("prop.shareCopy").disabled,false);
});

test("viewer: a late generation failure cannot replace a newer share",async()=>{
  const f=await fixture("viewer"),pending=deferred();
  await f.open(pending.promise);await f.open(info("newer"));
  pending.reject(Error("old failure"));await flush();
  assert.match(f.text(),/example.test\/newer/);
  assert.doesNotMatch(f.text(),/prop.shareFailed/);
});

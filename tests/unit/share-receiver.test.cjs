const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const directory = path.resolve(__dirname, "../../src-tauri/src/lan_share_page");
const dictionaries = Object.fromEntries(["zh-CN", "en", "ja"].map(locale => [locale, JSON.parse(fs.readFileSync(path.join(directory, `${locale}.json`), "utf8"))]));
const code = fs.readFileSync(path.join(directory, "page.js"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const elements = new Map(), intervals = [], timers = new Map();
  let now = 0, timerId = 0, legacyCopies = 0;
  const documentHandlers = new Map(), windowHandlers = new Map();
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const handlers = new Map();
    const value = {hidden:false,textContent:"",value:"",dataset:{},src:"http://192.168.1.2:4567/s/test/image",naturalWidth:2560,naturalHeight:1440,complete:true,
      addEventListener:(type,handler)=>handlers.set(type,handler),
      fire:(type,event)=>handlers.get(type)?.(event),
      focus(){this.focused=true;},select(){this.selected=true;},setSelectionRange(){this.selected=true;},
    };
    elements.set(id,value);
    return value;
  }
  element("translations").textContent = JSON.stringify(dictionaries);
  element("link-panel").hidden = true;
  const body = {dataset:{bytes:"2516582",seconds:String(options.seconds ?? 60),remaining:"-1",mime:"image/jpeg",filename:"photo.jpg"}};
  const document = {body,documentElement:{},hidden:false,
    getElementById:element,querySelectorAll:()=>[],
    addEventListener:(type,handler)=>documentHandlers.set(type,handler),
    execCommand:()=>{legacyCopies++;return options.legacyCopy ?? false;},
  };
  const window = {isSecureContext:options.secure ?? false,addEventListener:(type,handler)=>windowHandlers.set(type,handler)};
  const context = {document,window,navigator:{languages:options.languages ?? ["zh-CN"],userAgent:options.userAgent ?? "",...options.navigator},
    URL,AbortController,Date:{now:()=>now},location:{href:"http://192.168.1.2:4567/s/test?tracking=1#fragment"},
    setInterval:(fn,ms)=>{intervals.push({fn,ms});return intervals.length;},
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    fetch:options.fetch ?? (async()=>({ok:true,json:async()=>({active:true,expires_in_seconds:60,downloads_remaining:null})})),
  };
  vm.runInNewContext(code,context);
  return {element,document,window,intervals,timers,documentHandlers,windowHandlers,get legacyCopies(){return legacyCopies;},advance(ms){now+=ms;intervals.find(t=>t.ms===1000).fn();}};
}

test("receiver languages have matching keys and format actual image metadata",()=>{
  const keys=Object.keys(dictionaries["zh-CN"]).sort();
  for(const locale of ["en","ja"])assert.deepEqual(Object.keys(dictionaries[locale]).sort(),keys);
  for(const [languages,locale] of [[["zh-TW"],"zh-CN"],[["fr-FR","ja-JP"],"ja"],[["en-US"],"en"],[["de"],"en"]]){
    const f=fixture({languages});
    assert.equal(f.document.documentElement.lang,locale);
    assert.match(f.element("file-meta").textContent,/JPEG · 2560 × 1440 · 2[.,]4 MB/);
    assert.equal(f.element("download-limit").textContent,dictionaries[locale].unlimited);
  }
});

test("HTTP link sharing exposes a selected link when automatic copy is blocked",async()=>{
  const f=fixture({userAgent:"MicroMessenger"});
  await f.element("share-button").fire("click");
  assert.equal(f.element("link-panel").hidden,false);
  assert.equal(f.element("share-link").value,"http://192.168.1.2:4567/s/test");
  assert.equal(f.element("share-link").selected,true);
  assert.equal(f.legacyCopies,1);
  assert.equal(f.element("feedback").textContent,dictionaries["zh-CN"].manualCopy);
  assert.equal(f.element("wechat-hint").hidden,false);
});

test("HTTP legacy copy reports success only when the browser accepts copying",async()=>{
  const f=fixture({legacyCopy:true});
  await f.element("share-button").fire("click");
  assert.equal(f.element("feedback").textContent,dictionaries["zh-CN"].copied);
});

test("native sharing uses the canonical link and respects cancellation",async()=>{
  let shared;
  const f=fixture({secure:true,navigator:{share:async data=>{shared=data;}}});
  await f.element("share-button").fire("click");
  assert.equal(shared.url,"http://192.168.1.2:4567/s/test");
  assert.equal(f.legacyCopies,0);
  const cancelled=fixture({secure:true,navigator:{share:async()=>{throw {name:"AbortError"};}}});
  await cancelled.element("share-button").fire("click");
  assert.equal(cancelled.element("link-panel").hidden,true);
  assert.equal(cancelled.legacyCopies,0);
});

test("native share failure falls back to copying and manual selection",async()=>{
  const f=fixture({secure:true,navigator:{share:async()=>{throw new Error("Unsupported");},clipboard:{writeText:async()=>{throw new Error("Denied");}}}});
  await f.element("share-button").fire("click");
  assert.equal(f.element("link-panel").hidden,false);
  assert.equal(f.element("feedback").textContent,dictionaries["zh-CN"].manualCopy);
});

test("late status responses cannot reactivate an expired share",async()=>{
  let resolve;
  const pending=new Promise(ok=>resolve=ok);
  const f=fixture({seconds:1,fetch:()=>pending});
  const request=f.intervals.find(t=>t.ms===15000).fn();
  f.advance(1001);
  resolve({ok:true,json:async()=>({active:true,expires_in_seconds:120,downloads_remaining:null})});
  await request;
  assert.equal(f.element("file-content").hidden,true);
  assert.equal(f.element("state-title").textContent,dictionaries["zh-CN"].expiredTitle);
  await f.element("share-button").fire("click");
  assert.equal(f.legacyCopies,0);
});

test("connection failure shows retry and a later status check restores the live page",async()=>{
  let available=false;
  const f=fixture({fetch:async()=>{if(!available)throw new Error("Offline");return {ok:true,json:async()=>({active:true,expires_in_seconds:42,downloads_remaining:1})};}});
  await f.intervals.find(t=>t.ms===15000).fn();
  assert.equal(f.element("state-title").textContent,dictionaries["zh-CN"].offlineTitle);
  assert.equal(f.element("retry-button").hidden,false);
  available=true;
  f.element("retry-button").fire("click");
  await flush();
  assert.equal(f.element("file-content").hidden,false);
  assert.equal(f.element("download-limit").textContent,dictionaries["zh-CN"].once);
});

test("late clipboard success does not replace expiry feedback",async()=>{
  let resolve;
  const pending=new Promise(ok=>resolve=ok);
  const f=fixture({seconds:1,secure:true,navigator:{clipboard:{writeText:()=>pending}}});
  const copying=f.element("copy-button").fire("click");
  f.advance(1001);
  resolve();await copying;
  assert.equal(f.element("feedback").textContent,"");
  assert.equal(f.element("link-panel").hidden,true);
});

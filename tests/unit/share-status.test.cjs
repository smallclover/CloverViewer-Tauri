const assert=require("node:assert/strict");
const test=require("node:test");
const loadTs=require("./helpers/load-ts.cjs");
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup() {
  let interval,cleared=0,now=0;const pending=[],ticks=[];let expired=0;
  const {watchShareStatus}=loadTs("ui/share-status.ts",{}, {Date:{now:()=>now},window:{setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{cleared++;}}});
  const stop=watchShareStatus({seconds:60,read:()=>new Promise(resolve=>pending.push(resolve)),onTick:n=>ticks.push(n),onExpired:()=>{expired++;}});
  return {stop,pending,ticks,tick:()=>interval(),time:n=>{now=n;},expired:()=>expired,cleared:()=>cleared};
}
test("download invalidation updates the panel before the countdown expires and queries are deduplicated",async()=>{
  const f=setup();f.tick();f.tick();assert.equal(f.pending.length,1);
  f.pending.shift()(false);await flush();assert.equal(f.expired(),1);assert.equal(f.cleared(),1);
  f.tick();assert.equal(f.pending.length,0);
});
test("closing a panel suppresses its late status result",async()=>{
  const f=setup();f.stop();f.pending.shift()(false);await flush();assert.equal(f.expired(),0);
});
test("expiry also completes when the backend query is still pending",()=>{
  const f=setup();f.time(60000);f.tick();assert.equal(f.expired(),1);assert.equal(f.ticks.at(-1),0);
});

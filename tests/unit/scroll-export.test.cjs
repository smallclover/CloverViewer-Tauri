const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");

test("long screenshot exports reject duplicate clicks and allow another copy afterward", async () => {
  let resolve, calls = 0;
  const { createScrollCaptureController } = loadTs("screenshot/scroll-capture-controller.ts", {
    "../api": { finishScrollCapture: () => { calls++; return new Promise(done => { resolve = done; }); } },
  });
  const controller = createScrollCaptureController({
    session: { state: { phase: "done" } }, panel: {}, hud: {}, translate: key => key,
    showNotice() {}, closeScreenshot: async () => {},
  });
  const first = controller.finish("clipboard");
  await controller.finish("save");
  assert.equal(calls, 1);
  resolve(null); await first;
  const second = controller.finish("clipboard");
  assert.equal(calls, 2);
  resolve(null); await second;
});

test("a late export completion cannot close or update a new capture session", async () => {
  let resolve, closes=0, notices=0;
  const session = {state:{phase:"done",result:{id:1}}};
  const {createScrollCaptureController} = loadTs("screenshot/scroll-capture-controller.ts", {"../api":{finishScrollCapture: () => new Promise(done => {resolve = done;})}});
  const controller = createScrollCaptureController({session,panel:{},hud:{},translate:key=>key,showNotice(){notices++;},closeScreenshot:async()=>{closes++;}});
  const pending=controller.finish("save"); session.state.phase="idle";session.state.result=null; resolve("old.png");await pending;
  assert.equal(closes,0); assert.equal(notices,0);
});

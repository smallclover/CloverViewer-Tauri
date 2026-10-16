const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const { createEditorSaveController } = loadTs("image-editor/save-controller.ts");
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}) {
  const state = { session: 1, revision: 1, saved: 0, format: "png", writes: [], notices: [], callbacks: [] };
  const saves = createEditorSaveController({
    getEntry: () => ({ path: "photo.png", name: "photo.png" }),
    getFormat: () => state.format, getSession: () => state.session, getRevision: () => state.revision,
    prepare() {}, exportPng: async () => "png", choosePath: async () => "copy.png", confirmOverwrite: async () => true,
    saveImage: async (...args) => { state.writes.push(args); }, markSaved: rev => { state.saved = rev; },
    onSaved: path => state.callbacks.push(path), translate: key => key, toast: key => state.notices.push(key), ...overrides,
  });
  return {state, saves};
}
test("saving marks only the exported revision and serializes duplicate actions", async () => {
  const write = deferred();
  const {state, saves} = setup({saveImage: () => write.promise});
  const first = saves.overwrite(); await tick();
  state.revision = 2;
  await saves.overwrite(); await saves.saveAs();
  assert.equal(saves.isBusy(), true);
  let idle = false; void saves.whenIdle().then(() => { idle = true; });
  assert.equal(idle, false);
  write.resolve(); await first;
  assert.equal(state.saved, 1);
  assert.notEqual(state.saved, state.revision);
  assert.deepEqual(state.callbacks, ["photo.png"]);
  assert.equal(saves.isBusy(), false);
});
test("failed exports leave the revision unsaved and can be retried", async () => {
  let fail = true;
  const {state, saves} = setup({saveImage: async () => { if (fail) throw Error("disk full"); }});
  await saves.overwrite();
  assert.equal(state.saved, 0); assert.deepEqual(state.notices, ["editor.saveFailed"]);
  fail = false; await saves.overwrite(); assert.equal(state.saved, 1);
});
test("a new session invalidates a late file dialog and a late completed write", async () => {
  const chooser = deferred();
  const {state, saves} = setup({choosePath: () => chooser.promise});
  const first = saves.saveAs(); state.session++; chooser.resolve("copy.png"); await first;
  assert.equal(state.writes.length, 0); assert.equal(state.saved, 0);
  const write = deferred();
  const next = setup({saveImage: () => write.promise});
  const second = next.saves.overwrite(); await tick(); next.state.session++; write.resolve(); await second;
  assert.equal(next.state.saved, 0); assert.equal(next.state.callbacks.length, 0);
});
test("save-as captures the selected format before opening the dialog", async () => {
  const chooser = deferred();
  const {state, saves} = setup({choosePath: () => chooser.promise});
  const pending = saves.saveAs(); state.format = "webp"; chooser.resolve("copy.png"); await pending;
  assert.deepEqual(state.writes, [["copy.png", "png", "png"]]);
});

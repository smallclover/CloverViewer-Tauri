const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const {createConfigWriter} = loadTs("ui/config-writer.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
test("a failed setting rolls back while a later independent change is retained and persisted", async () => {
  let current = {theme:"dark",zoom:1}; const tasks = [], writes = [];
  const writer = createConfigWriter({read: () => current, render: next => {current = next;}, persist: next => {
    writes.push({...next}); return new Promise((resolve,reject) => tasks.push({resolve,reject,next}));
  }});
  const first = writer.save({theme:"light"}); const rejected = assert.rejects(first, /denied/);
  const second = writer.save({zoom:2});
  assert.deepEqual({...current}, {theme:"light",zoom:2}); assert.equal(writes.length, 1);
  tasks.shift().reject(Error("denied")); await rejected; await tick();
  assert.deepEqual({...current}, {theme:"dark",zoom:2});
  const next = tasks.shift(); next.resolve(next.next); await second;
  assert.deepEqual(writes, [{theme:"light",zoom:1},{theme:"dark",zoom:2}]);
  assert.deepEqual({...current}, {theme:"dark",zoom:2});
});
test("a new idle transaction uses external changes and commits the server response", async () => {
  let current = {zoom:1,pet:false};
  const writer = createConfigWriter({read: () => current, render: next => {current = next;}, persist: async next => ({...next,zoom:Math.min(next.zoom,2)})});
  await writer.save({zoom:3}); assert.equal(current.zoom,2);
  current = {...current,pet:true}; await writer.save({zoom:1}); assert.equal(current.pet,true);
});

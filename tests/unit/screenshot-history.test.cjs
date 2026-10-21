const assert = require("node:assert/strict");
const test = require("node:test");
const { ShapeHistory } = require("../../.unit-test-dist/compiled/screenshot/history.js");
const { SnapshotHistory } = require("../../.unit-test-dist/compiled/image-editor/history.js");

const shape = (x) => ({ tool: "rect", start: { x, y: 0 }, end: { x: x + 10, y: 10 }, color: "#cc0000", strokeWidth: 2 });

test("image editor history availability follows undo, redo, new edits and reopening", () => {
  const history = new SnapshotHistory(value => ({ ...value }));
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  history.checkpoint({ rotation: 0 });
  assert.equal(history.canUndo, true);
  const previous = history.undo({ rotation: 90 });
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(previous), { rotation: 90 });
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);
  history.undo({ rotation: 90 });
  history.checkpoint({ rotation: 0 });
  assert.equal(history.canRedo, false);
  history.clear();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});

test("history restores the state before an edit and then restores the edit on redo", () => {
  const history = new ShapeHistory();
  const before = [shape(0)];
  history.checkpoint(before);
  const after = [shape(50)];

  const undone = history.undo(after);
  assert.equal(undone[0].start.x, 0);
  const redone = history.redo(undone);
  assert.equal(redone[0].start.x, 50);
});

test("history snapshots are isolated and a new edit invalidates redo", () => {
  const history = new ShapeHistory();
  const original = [shape(0)];
  history.checkpoint(original);
  original[0].start.x = 99;

  const undone = history.undo([shape(10)]);
  assert.equal(undone[0].start.x, 0);
  history.checkpoint(undone);
  assert.equal(history.redo(undone), null);
});

test("history keeps only the most recent fifty checkpoints", () => {
  const history = new ShapeHistory();
  for (let index = 0; index < 51; index += 1) history.checkpoint([shape(index)]);

  let current = [shape(51)];
  for (let index = 50; index >= 1; index -= 1) {
    current = history.undo(current);
    assert.equal(current[0].start.x, index);
  }
  assert.equal(history.undo(current), null);
});

test("history evicts old snapshots by memory while preserving undo and redo isolation", () => {
  const history = new SnapshotHistory(value => ({...value}), () => 8, 16);
  for(let i=0;i<3;i++) history.checkpoint({index:i});
  const two = history.undo({index:3}); assert.equal(two.index,2);
  const one = history.undo(two); assert.equal(one.index,1);
  assert.equal(history.undo(one),null);
  one.index=99;
  assert.equal(history.redo(one).index,2);
});

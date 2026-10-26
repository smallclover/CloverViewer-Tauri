const assert = require("node:assert/strict");
const test = require("node:test");
const { emptyBeauty, rebaseBeauty, resolveWatermarkText } = require("../../.unit-test-dist/compiled/image-beautify/model.js");
const { beautyLayout, watermarkPoint, rotatedSize, checkBeautySize } = require("../../.unit-test-dist/compiled/image-beautify/layout.js");
const loadTs = require("./helpers/load-ts.cjs");

test("disabled decoration preserves dimensions; shadow padding and border fully enclose content", () => {
  const d = emptyBeauty(500);
  let layout = beautyLayout(800, 500, d);
  assert.deepEqual([layout.width, layout.height, layout.content.x, layout.content.y], [800, 500, 0, 0]);
  d.enabled = true; d.frame.kind = "border"; d.frame.borderWidth = 3;
  layout = beautyLayout(800, 500, d);
  assert.deepEqual([layout.width, layout.height], [806, 506]);
  d.frame.kind = "solid"; d.frame.padding = [1, 2, 3, 4]; d.frame.shadow = 10;
  layout = beautyLayout(800, 500, d);
  assert.equal(layout.content.x, 33); assert.equal(layout.content.y, 33);
  assert.equal(layout.regions.bottom.h, 33); assert.equal(layout.width, 866);
  d.frame.kind = "border"; d.frame.padding = [8,8,8,8];
  d.background.kind = "solid";
  assert.equal(beautyLayout(800,500,d).width,822);
});
test("preset rebasing preserves full composition and supports all anchors and rotated bounds", () => {
  const d = emptyBeauty(1000); d.enabled = true; d.frame.kind = "gradient";
  const before = beautyLayout(400, 200, d);
  const rebased = rebaseBeauty(d, 400, 200);
  const after = beautyLayout(400, 200, rebased);
  assert.deepEqual(after.content, before.content);
  assert.equal(rebased.referenceSize, 200);
  assert.equal(d.referenceSize, 1000);
  const region = {x: 10, y: 20, w: 100, h: 200};
  for (let anchor = 0; anchor < 9; anchor++) {
    const p = watermarkPoint(region, {anchor, x: 0, y: 0}, 1, 20, 40);
    assert.equal(p.x, 20 + anchor % 3 * 40);
    assert.equal(p.y, 40 + Math.floor(anchor / 3) * 80);
  }
  const size = rotatedSize(100, 40, 90);
  assert.ok(Math.abs(size.w - 40) < 1e-8); assert.ok(Math.abs(size.h - 100) < 1e-8);
});
test("frozen local time variables preserve unknown placeholders and reject oversized allocations", () => {
  assert.equal(resolveWatermarkText("{date} {time} {unknown}", new Date(2026, 9, 25, 8, 9, 3)), "2026-10-25 08:09:03 {unknown}");
  for (const size of [[0, 10], [40000, 1], [8000, 8000], [NaN, 1]]) assert.throws(() => checkBeautySize(...size));
  assert.doesNotThrow(() => checkBeautySize(3840, 2160));
});
test("screenshot history restores decoration and annotations in order after moving selection", () => {
  const { createEditorSession } = loadTs("screenshot/editor-session.ts");
  const s = createEditorSession({color: "#000000", strokeWidth: 2});
  s.selection = {x:100,y:50,w:400,h:200};
  const shape = {tool:"rect",start:{x:110,y:60},end:{x:140,y:90},color:"#000000",strokeWidth:2};
  s.checkpoint(); s.shapes.push(shape);
  s.checkpoint(); s.beauty = {...emptyBeauty(), enabled:true};
  s.selection = {x:200,y:150,w:400,h:200};
  s.undo(); assert.equal(s.beauty.enabled, false); assert.equal(s.shapes[0].start.x, 210);
  s.undo(); assert.equal(s.shapes.length, 0);
  s.redo(); assert.equal(s.shapes[0].start.y, 160);
  s.redo(); assert.equal(s.beauty.enabled, true);
});

test("six frame layouts retain source pixels and rebase every structural dimension", () => {
  const { builtinPresets } = loadTs("image-beautify/presets.ts");
  const presets = JSON.parse(JSON.stringify(builtinPresets()));
  assert.deepEqual(presets.map(p => p.id), ["mac-light","mac-dark","browser","gallery","wood","polaroid"]);
  for (const preset of presets) {
    const before = beautyLayout(800,500,preset.document);
    const rebased = rebaseBeauty(preset.document,800,500);
    const after = beautyLayout(800,500,rebased);
    assert.deepEqual({...after,scale:before.scale},before);
    assert.equal(after.content.w,800); assert.equal(after.content.h,500);
    const odd = beautyLayout(1001,667,rebased);
    assert.equal(odd.content.x,Math.round(odd.content.x));
    assert.equal(odd.content.y,Math.round(odd.content.y));
    rebased.enabled = false;
    const disabled = beautyLayout(800,500,rebased);
    assert.deepEqual([disabled.width,disabled.height,disabled.content.x,disabled.content.y],[800,500,0,0]);
  }
  const mac = beautyLayout(800,500,presets[0].document);
  assert.equal(mac.content.y-mac.shell.y,33);
  assert.equal(mac.content.x-mac.shell.x,1);
  const gallery = beautyLayout(800,500,presets[3].document);
  assert.equal(gallery.content.x-gallery.shell.x,84);
  assert.equal(gallery.regions.top.h,60);
  const paper = beautyLayout(800,500,presets[5].document);
  assert.equal(paper.content.x-paper.shell.x,22);
  assert.equal(paper.shell.y+paper.shell.h-paper.content.y-500,105);
});

test("v1 documents migrate without changing geometry, watermark positions or legacy IDs", () => {
  const { migrateBeauty, beautyBackground } = require("../../.unit-test-dist/compiled/image-beautify/model.js");
  const { allBuiltinPresets, legacyPresets } = loadTs("image-beautify/presets.ts", {}, {structuredClone, crypto});
  for (const kind of ["solid","gradient"]) {
    const old = emptyBeauty(); delete old.background;
    old.enabled = true; old.frame.kind = kind; old.frame.padding = [45,80,120,60];
    const migrated = migrateBeauty(old);
    assert.equal(migrated.frame.kind,"card");
    assert.equal(beautyBackground(migrated).kind,kind);
    assert.deepEqual(beautyLayout(800,500,old),beautyLayout(800,500,migrated));
    assert.equal(old.frame.kind,kind);
    assert.deepEqual(migrateBeauty(migrated),migrated);
  }
  assert.deepEqual(Array.from(legacyPresets(),p => p.id),["clean","gradient","brand","marked"]);
  assert.equal(allBuiltinPresets().length,10);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const { groupLines, readingOrder, paragraphText } = require("../../.unit-test-dist/compiled/ocr/layout.js");
const { createOcrSession, unitsFor, selectedState, toggleUnit, editBlock, copyContent } = require("../../.unit-test-dist/compiled/ocr/selection.js");
const { intersectsRect } = require("../../.unit-test-dist/compiled/ocr/geometry.js");
const line = (id, text, x, y, width = 200) => ({id, text, quad: [{x,y},{x:x+width,y},{x:x+width,y:y+16},{x,y:y+16}]});
const document = lines => ({version:1,imageWidth:1000,imageHeight:800,text:lines.map(l=>l.text).join("\n"),lines});
const fixture = () => document([
  line("a","第一段第一行",10,10), line("b","第二行",10,35),
  line("c","下一条消息",100,120), line("d","最后一行",100,145),
]);

test("paragraph grouping keeps separate messages and reading order is independent of click order", () => {
  const session = createOcrSession(fixture());
  assert.equal(session.blocks.length,2);
  const units = unitsFor(session,false);
  toggleUnit(session,units[1]); toggleUnit(session,units[0]);
  assert.equal(copyContent(session,"paragraphs"),"第一段第一行第二行\n\n下一条消息最后一行");
  assert.equal(copyContent(session,"lines"),"第一段第一行\n第二行\n下一条消息\n最后一行");
  toggleUnit(session,units[0]);
  assert.equal(copyContent(session,"paragraphs"),"下一条消息最后一行");
});

test("line selection survives view switches and a partially selected paragraph becomes atomic after editing", () => {
  const session = createOcrSession(fixture());
  toggleUnit(session,unitsFor(session,true)[1]);
  assert.equal(selectedState(session,unitsFor(session,false)[0]),"some");
  assert.equal(copyContent(session,"lines"),"第二行");
  editBlock(session,session.blocks[0],"新文字\n手动换行");
  assert.equal(selectedState(session,unitsFor(session,false)[0]),"all");
  assert.equal(unitsFor(session,true).length,3);
  assert.equal(copyContent(session,"paragraphs"),"新文字\n手动换行");
  assert.equal(copyContent(session,"lines"),"新文字\n手动换行");
  editBlock(session,session.blocks[0],null);
  assert.equal(unitsFor(session,true).length,4);
  assert.equal(copyContent(session,"lines"),"第一段第一行\n第二行");
});

test("legacy text remains editable without invented image coordinates", () => {
  const session = createOcrSession("old\ntext");
  assert.equal(session.document,undefined);
  toggleUnit(session,unitsFor(session,false)[0]);
  assert.equal(copyContent(session,"paragraphs"),"old\ntext");
  editBlock(session,session.blocks[0],"edited");
  assert.equal(copyContent(session,"lines",true),"edited");
});

test("simple columns read down each column and large gaps, indentation or angle changes do not merge", () => {
  const lines = [line("a","left 1",0,0,100),line("b","right 1",400,0,100),line("c","left 2",0,24,100),line("d","right 2",400,24,100)];
  assert.deepEqual(readingOrder(lines).map(l=>l.id),["a","c","b","d"]);
  assert.equal(groupLines(document(lines)).length,2);
  assert.equal(groupLines(document([line("a","a",0,0),line("b","b",100,24),line("c","c",0,120)])).length,3);
  const rotated = line("b","b",0,24); rotated.quad[1].y += 90;
  assert.equal(groupLines(document([lines[0],rotated])).length,2);
});

test("copy normalization preserves English words, CJK boundaries, lists and file paths", () => {
  assert.equal(paragraphText(["Hello world", "next line"]),"Hello world next line");
  assert.equal(paragraphText(["日本語の", "文字認識"]),"日本語の文字認識");
  assert.equal(paragraphText(["src/foo.ts", "src/bar.ts"]),"src/foo.ts\nsrc/bar.ts");
  assert.equal(paragraphText(["1. first", "2. second"]),"1. first\n2. second");
});

test("box selection tests actual rotated quadrilaterals rather than only their bounding boxes", () => {
  const diamond = [{x:10,y:0},{x:20,y:10},{x:10,y:20},{x:0,y:10}];
  assert.equal(intersectsRect(diamond,{x:9,y:9},{x:11,y:11}),true);
  assert.equal(intersectsRect(diamond,{x:0,y:0},{x:2,y:2}),false);
  assert.equal(intersectsRect(diamond,{x:30,y:30},{x:25,y:25}),false);
  assert.equal(intersectsRect(diamond,{x:25,y:25},{x:-5,y:-5}),true);
});

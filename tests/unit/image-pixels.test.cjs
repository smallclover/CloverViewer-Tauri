const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
test("AVIF copies and shares use same-origin decoded browser pixels; native formats bypass conversion", async () => {
  const read = [], draws = [], canvases = []; let released = 0;
  const {createImagePixelExporter, IMAGE_EXTENSIONS} = loadTs("viewer/image-pixels.ts", {}, {
    Image: class {naturalWidth = 3; naturalHeight = 2; async decode() {assert.equal(this.src,"data:image/avif;base64,source");} removeAttribute() {released++;}},
    FileReader: class {readAsDataURL() {this.result = "data:image/png;base64,pixels"; this.onload();}},
    document: {createElement: () => {const canvas = {getContext: () => ({drawImage: (...args) => draws.push(args)}), toBlob: callback => {canvas.exportedSize=[canvas.width,canvas.height];callback({});}}; canvases.push(canvas); return canvas;}},
  });
  const convert = createImagePixelExporter(async path => {read.push(path); return "data:image/avif;base64,source";});
  assert.equal(await convert("photo.PNG"), undefined); assert.equal(read.length,0);
  assert.equal(await convert("photo.AVIF"), "data:image/png;base64,pixels");
  assert.deepEqual(canvases[0].exportedSize,[3,2]); assert.equal(canvases[0].width,0); assert.equal(canvases[0].height,0); assert.equal(draws.length,1); assert.equal(released,1);
  await convert("photo.avif",2); assert.deepEqual(canvases[1].exportedSize,[2,1]);
  assert(IMAGE_EXTENSIONS.includes("tif")); assert(IMAGE_EXTENSIONS.includes("tiff"));
});
test("browser decode failures are propagated and release the source", async () => {
  let released = false;
  const {createImagePixelExporter} = loadTs("viewer/image-pixels.ts", {}, {
    Image: class {async decode() {throw Error("decode failed");} removeAttribute() {released = true;}},
  });
  await assert.rejects(createImagePixelExporter(async () => "data:bad")("bad.avif"), /decode failed/);
  assert.equal(released,true);
});

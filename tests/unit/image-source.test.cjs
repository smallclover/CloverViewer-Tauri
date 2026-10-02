const assert = require("node:assert/strict");
const test = require("node:test");
const { createImageSourceResolver } = require("../../.unit-test-dist/viewer/image-source.js");

const webImage = { path: "C:/images/photo.png", web_supported: true };
const fallbackImage = { path: "C:/images/photo.tiff", web_supported: false };

test("web-compatible images bypass decoding", async () => {
  let decoded = 0;
  const resolver = createImageSourceResolver({
    fileSrc: (path) => `asset://${path}`,
    readImageData: async () => {
      decoded += 1;
      return "unused";
    },
  });

  assert.equal(await resolver.for(webImage), "asset://C:/images/photo.png");
  assert.equal(decoded, 0);
});

test("fallback images are cached, evicted at the capacity boundary, and clearable", async () => {
  const calls = new Map();
  const resolver = createImageSourceResolver({
    fileSrc: (path) => `asset://${path}`,
    readImageData: async (path) => {
      calls.set(path, (calls.get(path) ?? 0) + 1);
      return `data:${path}`;
    },
  });

  assert.equal(await resolver.for(fallbackImage), "data:C:/images/photo.tiff");
  assert.equal(await resolver.for(fallbackImage), "data:C:/images/photo.tiff");
  assert.equal(calls.get(fallbackImage.path), 1);

  for (let index = 0; index < 20; index += 1) {
    await resolver.for({ path: `C:/images/${index}.tiff`, web_supported: false });
  }
  await resolver.for(fallbackImage);
  assert.equal(calls.get(fallbackImage.path), 2);

  resolver.clear();
  await resolver.for(fallbackImage);
  assert.equal(calls.get(fallbackImage.path), 3);
});

test("fallback source requests share native decoding and clearing isolates in-flight results", async () => {
  const reads = [];
  const resolver = createImageSourceResolver({
    fileSrc: path => path,
    readImageData: () => new Promise(resolve => reads.push(resolve)),
  });
  const first = resolver.for(fallbackImage), duplicate = resolver.for(fallbackImage);
  assert.equal(reads.length, 1);
  resolver.clear();
  const fresh = resolver.for(fallbackImage);
  assert.equal(reads.length, 2);
  reads[1]("new pixels");
  assert.equal(await fresh, "new pixels");
  reads[0]("obsolete pixels");
  assert.equal(await first, "obsolete pixels");
  assert.equal(await duplicate, "obsolete pixels");
  assert.equal(await resolver.for(fallbackImage), "new pixels");
  assert.equal(reads.length, 2);
});

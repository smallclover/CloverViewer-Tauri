const assert = require("node:assert/strict");
const test = require("node:test");
const { createImageSourceResolver } = require("../../.unit-test-dist/compiled/viewer/image-source.js");

const webImage = { path: "C:/images/photo.png", web_supported: true };
const fallbackImage = { path: "C:/images/photo.tiff", web_supported: false };

test("fallback cache enforces its byte budget and file versions", async () => {
  let calls = 0;
  const resolver = createImageSourceResolver({maxBytes:16, fileSrc:path=>path, readImageData:async()=>{calls++;return "12345678";}});
  await resolver.for({...fallbackImage, modified:"first"});
  await resolver.for({...fallbackImage, modified:"second"});
  await resolver.for({...fallbackImage, modified:"first"});
  assert.equal(calls,3);
  const large = createImageSourceResolver({maxBytes:4,fileSrc:path=>path,readImageData:async()=>{calls++;return "too large";}});
  await large.for(fallbackImage);await large.for(fallbackImage); assert.equal(calls,5);
});

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

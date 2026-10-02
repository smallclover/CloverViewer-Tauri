const assert = require("node:assert/strict");
const test = require("node:test");
const { createImageEditorLoader } = require("../../.unit-test-dist/viewer/image-editor-loader.js");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("editor opening waits for source and decode before returning a usable image", async () => {
  const source = deferred();
  const decoded = deferred();
  const image = { src: "", decode: () => decoded.promise };
  const loader = createImageEditorLoader({ getSource: () => source.promise, createImage: () => image });
  let ready = false;
  const opening = loader.load("a.png").then(value => { ready = true; return value; });
  assert.equal(loader.isLoading(), true);
  assert.equal(image.src, "");
  source.resolve("data:a");
  await Promise.resolve();
  assert.equal(image.src, "data:a");
  assert.equal(ready, false);
  decoded.resolve();
  assert.equal(await opening, image);
  assert.equal(loader.isLoading(), false);
});

test("canceled source reads do not decode or reopen, including late failures", async () => {
  const source = deferred();
  const loader = createImageEditorLoader({ getSource: () => source.promise, createImage: () => { throw new Error("unexpected decode"); } });
  const opening = loader.load("a.png");
  loader.cancel();
  assert.equal(loader.isLoading(), false);
  source.resolve("data:a");
  assert.equal(await opening, null);
  const failed = deferred();
  const failedLoader = createImageEditorLoader({ getSource: () => failed.promise });
  const abandoned = failedLoader.load("bad.png");
  failedLoader.cancel();
  failed.reject(new Error("late read failure"));
  assert.equal(await abandoned, null);
});

test("latest edit selection wins even when an earlier decode finishes first", async () => {
  const first = deferred(), second = deferred();
  const images = [];
  const loader = createImageEditorLoader({
    getSource: async path => path,
    createImage: () => {
      const image = { src: "", decode: () => (images[0] === image ? first : second).promise };
      images.push(image);
      return image;
    },
  });
  const a = loader.load("a.png");
  await Promise.resolve();
  const b = loader.load("b.png");
  await Promise.resolve();
  first.resolve();
  assert.equal(await a, null);
  assert.equal(loader.isLoading(), true);
  second.resolve();
  assert.equal(await b, images[1]);
  assert.equal(loader.isLoading(), false);
});

test("active decode failures are reported and opening can be retried", async () => {
  let broken = true;
  const image = { src: "", decode: async () => { if (broken) throw new Error("corrupt"); } };
  const loader = createImageEditorLoader({ getSource: async () => "data:a", createImage: () => image });
  await assert.rejects(loader.load("a.png"), /corrupt/);
  assert.equal(loader.isLoading(), false);
  broken = false;
  assert.equal(await loader.load("a.png"), image);
});

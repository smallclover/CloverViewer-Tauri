const assert = require("node:assert/strict");
const test = require("node:test");
const { createSingleImageLoader } = require("../../.unit-test-dist/viewer/single-image-loader.js");

const entry = (path, width = 64) => ({ path, name: path, width, height: width, size: 1, modified: "2026-10-01" });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(maxBytes) {
  const calls = [], sources = new Map(), entries = new Map(), images = [];
  let decodeFailures = 0;
  const loader = createSingleImageLoader({
    maxBytes,
    sourceFor: image => {
      calls.push(image.path); entries.set(image.path, image);
      return new Promise((resolve, reject) => sources.set(image.path, { resolve, reject }));
    },
    createImage: () => {
      const image = {
        isConnected: false, naturalWidth: 0, naturalHeight: 0,
        set src(value) {
          this.source = value;
          this.naturalWidth = entries.get(value)?.width ?? 0;
          this.naturalHeight = entries.get(value)?.height ?? 0;
        },
        async decode() { if (decodeFailures-- > 0) throw new Error("Corrupt image"); },
        removeAttribute() { this.source = ""; },
      };
      images.push(image); return image;
    },
  });
  return { loader, calls, sources, images, failDecode: () => decodeFailures++ };
}

test("neighbor warmup shares the decoded image and bounds simultaneous source loads", async () => {
  const { loader, calls, sources } = setup();
  const a = entry("a"), b = entry("b"), c = entry("c");
  const first = loader.load(a);
  loader.preload([b, c]);
  assert.deepEqual(calls, ["a", "b"]);
  sources.get("a").resolve("a");
  const decoded = await first;
  await tick();
  assert.deepEqual(calls, ["a", "b", "c"]);
  sources.get("b").resolve("b"); sources.get("c").resolve("c");
  await tick();
  assert.equal(await loader.load(a), decoded);
  assert.equal((await loader.load(b)).source, "b");
  assert.deepEqual(calls, ["a", "b", "c"]);
});

test("a foreground selection takes priority over queued neighbor decoding", async () => {
  const { loader, calls, sources } = setup();
  const first = loader.load(entry("a"));
  loader.preload([entry("b"), entry("c")]);
  const latest = loader.load(entry("d"));
  assert.equal(await first, null);
  sources.get("a").resolve("a"); await tick();
  assert.deepEqual(calls, ["a", "b", "d"]);
  sources.get("d").resolve("d");
  assert.equal((await latest).source, "d");
  sources.get("b").resolve("b"); await tick();
  loader.clear();
});

test("leaving a neighborhood cancels queued images before they reach the backend", async () => {
  const { loader, calls, sources } = setup();
  const a = entry("a"), b = entry("b");
  const first = loader.load(a), second = loader.load(b), stale = loader.load(entry("c"));
  loader.retain([a, b]);
  assert.equal(await stale, null);
  sources.get("a").resolve("a"); sources.get("b").resolve("b");
  await Promise.all([first, second]); await tick();
  assert.deepEqual(calls, ["a", "b"]);
});

test("clearing during a native read never decodes or caches the obsolete result", async () => {
  const { loader, calls, sources, images } = setup();
  const pending = loader.load(entry("a"));
  const stale = sources.get("a");
  loader.clear();
  assert.equal(await pending, null);
  stale.resolve("a"); await tick();
  assert.equal(images[0].source, "");
  const fresh = loader.load(entry("a"));
  sources.get("a").resolve("a");
  assert.equal((await fresh).source, "a");
  assert.deepEqual(calls, ["a", "a"]);
});

test("decoded memory budget skips speculative large images while allowing the selected image", async () => {
  const { loader, calls, sources } = setup(32 * 1024);
  const first = loader.load(entry("a")); sources.get("a").resolve("a"); await first;
  loader.preload([entry("b"), entry("large", 1024)]);
  assert.deepEqual(calls, ["a", "b"]);
  sources.get("b").resolve("b"); await tick();
  const large = loader.load(entry("large", 1024));
  sources.get("large").resolve("large");
  assert.equal((await large).naturalWidth, 1024);
  loader.preload([entry("c")]);
  assert.deepEqual(calls, ["a", "b", "large"]);
});

test("failed image decoding can be retried rather than leaving a rejected cache entry", async () => {
  const { loader, calls, sources, failDecode } = setup();
  failDecode();
  const broken = loader.load(entry("a")); sources.get("a").resolve("a");
  await assert.rejects(broken, /Corrupt image/);
  const retry = loader.load(entry("a")); sources.get("a").resolve("a");
  assert.equal((await retry).source, "a");
  assert.deepEqual(calls, ["a", "a"]);
});

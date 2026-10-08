const test = require("node:test");
const assert = require("node:assert/strict");
const { centerColorHex } = require("../../.unit-test-dist/screenshot/magnifier.js");
const { createMagnifierRenderer } = require("../../.unit-test-dist/screenshot/magnifier.js");

test("magnifier copies the center pixel as an uppercase hex color", () => {
  const pixels = new Uint8ClampedArray(3 * 3 * 4);
  const center = (1 * 3 + 1) * 4;
  pixels.set([10, 171, 255, 128], center);

  assert.equal(centerColorHex(pixels, 3), "#0AABFF");
});

test("magnifier caches integer pixel samples, invalidates new captures and scales the sample once", () => {
  const previousDocument = global.document;
  const canvases = [];
  let reads = 0;
  let image = {};
  let copiedAt = -Infinity;
  const makeCanvas = () => {
    const canvas = { width: 0, height: 0 };
    const calls = [];
    const context = new Proxy({ canvas, calls, measureText: () => ({ width: 45 }),
      getImageData: () => {
        reads++;
        const data = new Uint8ClampedArray(15 * 15 * 4);
        for (let index = 0; index < data.length; index += 4) data.set([10, 171, 255, 255], index);
        return { data };
      },
    }, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]) });
    canvas.getContext = () => context;
    canvases.push(canvas);
    return canvas;
  };
  global.document = { createElement: makeCanvas };
  try {
    const magnifier = createMagnifierRenderer({ getScreens: () => [{ image, x: 0, y: 0, w: 1000, h: 1000 }],
      getViewport: () => ({ width: 500, height: 500 }), getScale: () => 2,
      translate: key => key, getCopyColorHotkey: () => "Alt+C", getCopiedAt: () => copiedAt,
    });
    const target = makeCanvas().getContext();
    magnifier.draw(target, 100.1, 100.1);
    assert.equal(reads, 1);
    assert.equal(target.calls.filter(([name]) => name === "fillRect").length, 1);
    assert.equal(target.calls.filter(([name]) => name === "drawImage").length, 1);
    assert.equal(target.imageSmoothingEnabled, false);
    assert.deepEqual(target.calls.find(([name]) => name === "drawImage").slice(1), [canvases[0], 0, 0, 15, 15, 140.1, 140.1, 300, 300]);
    assert.equal(magnifier.colorAt(100.3, 100.3), "#0AABFF");
    assert.equal(reads, 1);
    copiedAt = performance.now();
    magnifier.draw(target, 100.3, 100.3);
    assert.ok(target.calls.some(([name, text]) => name === "fillText" && text === "shot.copied"));
    copiedAt = -Infinity;
    magnifier.draw(target, 100.3, 100.3);
    assert.equal(target.calls.filter(([name]) => name === "fillText").at(-2)[1], "#0AABFF");
    assert.equal(reads, 1, "copy feedback expires without another pixel read");
    magnifier.colorAt(100.8, 100.8);
    assert.equal(reads, 2);
    image = {};
    magnifier.colorAt(100.8, 100.8);
    assert.equal(reads, 3);
    const box = magnifier.getBox(990, 990);
    assert.ok(box.x >= 0 && box.x + box.w <= 500 && box.y + box.h <= 500);
    magnifier.reset();
    assert.equal(canvases[0].width, 0);
    magnifier.colorAt(100.8, 100.8);
    assert.equal(reads, 4);
    assert.equal(canvases[0].width, 15);
  } finally { global.document = previousDocument; }
});

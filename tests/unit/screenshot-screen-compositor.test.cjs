const assert = require("node:assert/strict");
const test = require("node:test");
const { blitScreenRegion, drawScreenBase } = require("../../.unit-test-dist/screenshot/screen-compositor.js");

function createContext() {
  const calls = [];
  return {
    calls,
    canvas: { width: 400, height: 300 },
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    beginPath: () => calls.push(["beginPath"]),
    rect: (...args) => calls.push(["rect", ...args]),
    clip: () => calls.push(["clip"]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    drawImage: (...args) => calls.push(["drawImage", ...args]),
  };
}

const screens = [
  { image: "left", x: 0, y: 0, w: 100, h: 100 },
  { image: "right", x: 100, y: 0, w: 100, h: 100 },
];

test("screen compositor paints an opaque base before every screen", () => {
  const context = createContext();
  drawScreenBase(context, screens);

  assert.equal(context.fillStyle, "#14161c");
  assert.deepEqual(context.calls, [
    ["fillRect", 0, 0, 400, 300],
    ["drawImage", "left", 0, 0, 100, 100],
    ["drawImage", "right", 100, 0, 100, 100],
  ]);
});

test("screen compositor clips and maps a region spanning displays", () => {
  const context = createContext();
  blitScreenRegion(context, screens, 50, 20, 100, 40, 10, 30, 200, 80);

  assert.deepEqual(context.calls, [
    ["save"],
    ["beginPath"],
    ["rect", 10, 30, 200, 80],
    ["clip"],
    ["drawImage", "left", 50, 20, 50, 40, 10, 30, 100, 80],
    ["drawImage", "right", 0, 20, 50, 40, 110, 30, 100, 80],
    ["restore"],
  ]);
  assert.equal(context.imageSmoothingEnabled, true);
});

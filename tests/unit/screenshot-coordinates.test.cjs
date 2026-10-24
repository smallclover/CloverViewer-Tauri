const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const { createScreenshotCoordinates, screenshotPoint } = loadTs("screenshot/coordinates.ts");
const plain = value => JSON.parse(JSON.stringify(value));

test("screenshot coordinates invert CSS input and preserve independent horizontal and vertical scales", () => {
  const viewport = { left: 20, top: 40, width: 3000, height: 1200 };
  const bounds = { totalW: 6000, totalH: 3000 };
  const coordinates = createScreenshotCoordinates({ getViewport: () => viewport, getBounds: () => bounds, getScreens: () => [] });
  const point = screenshotPoint({ clientX: 320, clientY: 240 }, viewport, bounds);
  assert.deepEqual(plain(point), { x: 600, y: 500 });
  assert.deepEqual(plain(coordinates.toCssBox({ ...point, w: 800, h: 1000 })), { x: 300, y: 200, w: 400, h: 400 });
  assert.equal(coordinates.scale(), 2);
  assert.deepEqual(plain(coordinates.rootBox()), { x: 0, y: 0, w: 3000, h: 1200 });
});

test("staggered displays and cross-screen selections choose the monitor containing the physical center", () => {
  // 虚拟桌面原点可为 (-2000,-300)，加载器已将屏幕位置转换为截图局部坐标。
  const screens = [{ x: 0, y: 300, w: 2000, h: 1500 }, { x: 2000, y: 0, w: 4000, h: 3000 }];
  const coordinates = createScreenshotCoordinates({
    getViewport: () => ({ left: 0, top: 0, width: 3000, height: 1200 }),
    getBounds: () => ({ totalW: 6000, totalH: 3000 }), getScreens: () => screens,
  });
  assert.deepEqual(plain(coordinates.monitorBox({ x: 200, y: 400, w: 100, h: 100 })), { x: 0, y: 120, w: 1000, h: 600 });
  assert.deepEqual(plain(coordinates.monitorBox({ x: 1900, y: 400, w: 200, h: 100 })), { x: 1000, y: 0, w: 2000, h: 1200 });
  assert.deepEqual(plain(coordinates.monitorBox(null)), { x: 0, y: 0, w: 3000, h: 1200 });
  assert.deepEqual(plain(coordinates.monitorBox({ x: 10, y: 10, w: 20, h: 20 })), { x: 0, y: 120, w: 1000, h: 600 });
});

test("a selection centered in a monitor gap uses a real screen with the largest selected area", () => {
  const screens = [{ x:0,y:0,w:500,h:900 },{ x:700,y:200,w:1000,h:600 }];
  const coordinates = createScreenshotCoordinates({
    getViewport:()=>({left:0,top:0,width:1700,height:900}),getBounds:()=>({totalW:1700,totalH:900}),getScreens:()=>screens,
  });
  assert.deepEqual(plain(coordinates.monitorBox({x:400,y:250,w:350,h:400})),screens[0]);
  assert.deepEqual(plain(coordinates.monitorBox({x:450,y:250,w:350,h:400})),screens[1]);
});

test("a reused screenshot uses new bounds and viewport values without caching obsolete scale", () => {
  let viewport = { left: 0, top: 0, width: 1000, height: 500 };
  let bounds = { totalW: 2000, totalH: 1000 };
  let screens = [{ x: 0, y: 0, w: 2000, h: 1000 }];
  const coordinates = createScreenshotCoordinates({ getViewport: () => viewport, getBounds: () => bounds, getScreens: () => screens });
  assert.equal(coordinates.scale(), 2);
  viewport = { left: 100, top: 20, width: 800, height: 600 };
  bounds = { totalW: 3200, totalH: 2400 }; screens = [];
  assert.equal(coordinates.scale(), 4);
  assert.deepEqual(plain(coordinates.toCssBox({ x: 400, y: 400, w: 800, h: 800 })), { x: 100, y: 100, w: 200, h: 200 });
  assert.deepEqual(plain(screenshotPoint({ clientX: 200, clientY: 120 }, viewport, bounds)), { x: 400, y: 400 });
  assert.deepEqual(plain(coordinates.monitorBox({ x: 400, y: 400, w: 100, h: 100 })), { x: 0, y: 0, w: 800, h: 600 });
  bounds = { totalW: 0, totalH: 0 }; assert.equal(coordinates.scale(), 1);
  viewport.width = 0; bounds.totalW = 3200; assert.equal(coordinates.scale(), 1);
});

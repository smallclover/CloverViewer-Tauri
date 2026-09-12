// 纯几何验证：把 positionScrollUi / clampAvoiding / monitorBoxCss 的逻辑原样搬过来，
// 喂真实的多屏参数看落点（与 src/screenshot.ts 保持一致，改逻辑时同步改这里）。
//
// 真实环境（来自 .e2e-logs）：
//   主屏 2560x1440 @(0,0)，副屏（竖屏）1440x2560 @(-1440,0)
//   虚拟桌面 4000x2560（minX=-1440, minY=0），scale=1
//   覆盖窗 CSS 尺寸 3000x1920（= 4000x2560 / 1.3333）

const TOTAL_W = 4000, TOTAL_H = 2560, WIN_W = 3000, WIN_H = 1920;
const MIN_X = -1440, MIN_Y = 0;
const KX = WIN_W / TOTAL_W, KY = WIN_H / TOTAL_H;

// 与前端 screens[] 同构：root-local 物理像素
const SCREENS = [
  { x: 0 - MIN_X, y: 0 - MIN_Y, w: 2560, h: 1440, name: "主屏" },
  { x: -1440 - MIN_X, y: 0 - MIN_Y, w: 1440, h: 2560, name: "副屏(竖屏)" },
];

const toCssBox = (r) => ({ x: r.x * KX, y: r.y * KY, w: r.w * KX, h: r.h * KY });
const rootBoxCss = () => ({ x: 0, y: 0, w: WIN_W, h: WIN_H });
const uiClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const overlaps = (a, b) => a.x + a.w > b.x && a.x < b.x + b.w && a.y + a.h > b.y && a.y < b.y + b.h;

function monitorBoxCss(anchor) {
  const all = rootBoxCss();
  if (!anchor || SCREENS.length === 0) return all;
  const cx = anchor.x + anchor.w / 2;
  const cy = anchor.y + anchor.h / 2;
  const hit = SCREENS.find((s) => cx >= s.x && cx < s.x + s.w && cy >= s.y && cy < s.y + s.h);
  if (!hit) return all;
  return { x: hit.x * KX, y: hit.y * KY, w: hit.w * KX, h: hit.h * KY, name: hit.name };
}

function clampAvoiding(w, h, region, monitor, corner) {
  const minX = monitor.x + 10;
  const maxX = Math.max(minX, monitor.x + monitor.w - w - 10);
  const minY = monitor.y + 10;
  const maxY = Math.max(minY, monitor.y + monitor.h - h - 10);
  const wantX = corner === "tl" || corner === "bl" ? minX : maxX;
  const wantY = corner === "tl" || corner === "tr" ? minY : maxY;
  let x = uiClamp(wantX, minX, maxX);
  let y = uiClamp(wantY, minY, maxY);
  const hit = () => overlaps({ x, y, w, h }, region);
  if (hit()) {
    const leftOf = region.x - w - 10;
    const rightOf = region.x + region.w + 10;
    if (Math.abs(wantX - leftOf) <= Math.abs(wantX - rightOf)) x = uiClamp(leftOf, minX, maxX);
    else x = uiClamp(rightOf, minX, maxX);
  }
  if (hit()) {
    const above = region.y - h - 10;
    const below = region.y + region.h + 10;
    if (Math.abs(wantY - above) <= Math.abs(wantY - below)) y = uiClamp(above, minY, maxY);
    else y = uiClamp(below, minY, maxY);
  }
  return { x, y, w, h };
}

function report(name, selGlobal, panel = { w: 300, h: 96 }, hud = { w: 300, h: 130 }) {
  const sel = { x: selGlobal.x - MIN_X, y: selGlobal.y - MIN_Y, w: selGlobal.w, h: selGlobal.h };
  const region = toCssBox(sel);
  const monitor = monitorBoxCss(sel);
  const p = clampAvoiding(panel.w, panel.h, region, monitor, "br");
  const h = clampAvoiding(hud.w, hud.h, region, monitor, "tr");
  const gx = (v) => v / KX + MIN_X;
  const gy = (v) => v / KY + MIN_Y;
  const onWin = (v) => v.x >= 0 && v.y >= 0 && v.x + v.w <= WIN_W && v.y + v.h <= WIN_H;
  const where = (v) => {
    const X = gx(v.x), Y = gy(v.y);
    return `${X < 0 ? "副屏" : "主屏"} @物理(${X.toFixed(0)},${Y.toFixed(0)})`;
  };
  const tag = (v, r) => `${v.x.toFixed(0)},${v.y.toFixed(0)} ${v.w}x${v.h} 在窗内=${onWin(v)} 压选区=${overlaps(v, r)} ${where(v)}`;
  console.log(`\n[${name}]  选区(物理)=${JSON.stringify(selGlobal)}`);
  console.log(`  本屏(CSS)=${monitor.x.toFixed(0)},${monitor.y.toFixed(0)} ${monitor.w}x${monitor.h} (${monitor.name ?? "整窗"})  捕获区(CSS)=${region.x.toFixed(0)},${region.y.toFixed(0)} ${region.w}x${region.h}`);
  console.log(`  面板 ${tag(p, region)}`);
  console.log(`  HUD  ${tag(h, region)}`);
}

report("① 主屏全屏选区（用户报的遮挡场景）", { x: 0, y: 0, w: 2560, h: 1440 });
report("② 主屏右下角选区（旧代码会漂到第二块屏）", { x: 2200, y: 1100, w: 360, h: 340 });
report("③ 主屏左上角选区", { x: 0, y: 0, w: 500, h: 500 });
report("④ 主屏整窗（最大化浏览器）", { x: 8, y: 8, w: 2544, h: 1400 });
report("⑤ 副屏竖屏选区", { x: -1440, y: 400, w: 1440, h: 1600 });
report("⑥ 跨屏选区", { x: -300, y: 200, w: 1200, h: 1000 });
report("⑦ 主屏右边缘窄条", { x: 2400, y: 0, w: 160, h: 1440 });

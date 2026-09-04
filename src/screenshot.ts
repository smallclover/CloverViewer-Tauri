import { closeScreenshot, copyText, finishScreenshot, getConfig, getScreenshotData, ocrImage } from "./api";
import { applyI18n, setLang, t } from "./i18n";
import { listen } from "@tauri-apps/api/event";

// ============================================================
// 截图标注器 —— 移植自 CloverViewer feature/screenshot 的 Canvas 2D 重写
//
// 坐标约定：所有图形数据统一用「物理像素」（与 xcap 返回一致）。
// 前端仅做交互绘制；导出时用同一套 draw 逻辑在离屏 Canvas 上合成，
// 再交给 Rust 落盘/写剪贴板。
// ============================================================

interface Pt {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Tool = "rect" | "circle" | "arrow" | "pen" | "mosaic" | "text";

interface Shape {
  tool: Tool;
  start: Pt;
  end: Pt;
  color: string;
  strokeWidth: number; // 逻辑像素
  text?: string;
  points?: Pt[];
}

const MIN_SHAPE_SIZE = 4; // 物理像素
const HANDLE_HIT = 12; // 控制点命中半径（物理像素；不再随 devicePixelRatio 缩放）
const DEFAULT_COLOR = "#cc0000";
const DEFAULT_STROKE = 2;
const DEFAULT_MOSAIC = 16;

// 物理像素 / CSS 像素 —— 实时计算（不再用 devicePixelRatio 单值，
// multi-monitor mixed-DPI 时单值不可靠，会让 outer frame 与 inner viewport 比例同步错位）。
function physScale(): number {
  if (totalW <= 0) return 1;
  const w = root.getBoundingClientRect().width;
  return w > 0 ? totalW / w : 1;
}
const PALETTE = [
  "#cc0000", "#ff0000", "#ff6600", "#ffcc00", "#00cc00",
  "#0099ff", "#0000ff", "#9900ff", "#000000", "#ffffff",
];

// ---------- 状态 ----------
let totalW = 0;
let totalH = 0;
let minX = 0;
let minY = 0;
let screens: { img: HTMLImageElement; x: number; y: number; w: number; h: number }[] = [];

let selection: Rect | null = null;
let dragStart: Pt | null = null;
let dragCur: Pt | null = null;

let tool: Tool | null = null;
let color = DEFAULT_COLOR;
let strokeWidth = DEFAULT_STROKE;
let mosaicWidth = DEFAULT_MOSAIC;

let shapes: Shape[] = [];
let undoStack: Shape[][] = [];
let redoStack: Shape[][] = [];

let curShape: Shape | null = null; // 正在绘制
let selectedIndex: number | null = null;
let hoverIndex: number | null = null;

type DragMode = "none" | "select" | "move" | "resize";
let dragMode: DragMode = "none";
let resizeHandle = -1;
let moveStart: Pt | null = null;
let moveOrigShape: Shape | null = null;
let resizeOrig: { start: Pt; end: Pt; strokeWidth: number } | null = null;

// ---------- 放大镜 ----------
const MAG_GRID = 15; // 15×15 像素
const MAG_PIXEL = 10; // 每像素放大到 10 逻辑像素
const MAG_OFFSET = 20; // 与光标间距（逻辑像素）
const MAG_INFO_H = 64; // 信息栏高度（逻辑像素）
let lastMousePos: Pt | null = null;
let magnifierActive = true; // 读 config.magnifier_enabled，main() 里覆盖
let copiedAt = 0; // 最近一次复制色值的时间戳
let overUI = false; // 光标是否悬停在工具栏/弹窗上

// ---------- DOM ----------
const root = document.getElementById("screenshot-root")!;
const canvas = document.getElementById("overlay-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const uiLayer = document.getElementById("ui-layer")!;

// ============================================================
// 图标
// ============================================================
const ICONS: Record<string, string> = {
  rect: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/>',
  circle: '<ellipse cx="12" cy="12" rx="8.5" ry="7.5"/>',
  arrow: '<path d="M5 17 L19 5 M19 5 h-5 M19 5 v5"/>',
  pen: '<path d="M4 20 l5-1.5L20.5 7a2 2 0 0 0-2.8-2.8L6 15.5 4 20z"/>',
  mosaic: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  cancel: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  save: '<path d="M5 4h11l3 3v13H5zM8 4v5h8V4M8 20v-6h8v6"/>',
  ocr: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M7 9h10M7 12.5h10M7 16h6"/>',
};

function svgIcon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

function makeBtn(icon: string, titleKey: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.innerHTML = svgIcon(icon);
  b.title = t(titleKey);
  b.dataset.i18nTitle = titleKey;
  return b;
}

// ============================================================
// 工具栏
// ============================================================
const toolbar = document.createElement("div");
toolbar.className = "toolbar ui-interactive";

const TOOLS: { t: Tool; icon: string; title: string }[] = [
  { t: "rect", icon: "rect", title: "shot.rect" },
  { t: "circle", icon: "circle", title: "shot.circle" },
  { t: "arrow", icon: "arrow", title: "shot.arrow" },
  { t: "pen", icon: "pen", title: "shot.pen" },
  { t: "mosaic", icon: "mosaic", title: "shot.mosaic" },
  { t: "text", icon: "text", title: "shot.text" },
];

const toolBtns = new Map<Tool, HTMLButtonElement>();
for (const { t, icon, title } of TOOLS) {
  const b = makeBtn(icon, title);
  b.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    setTool(tool === t ? null : t);
  });
  toolBtns.set(t, b);
  toolbar.appendChild(b);
}

// 分隔线
const divider = document.createElement("div");
divider.className = "divider";
toolbar.appendChild(divider);

// 颜色
const colorBtn = makeBtn("color", "shot.color");
const colorSwatch = document.createElement("div");
colorSwatch.className = "swatch";
colorSwatch.style.background = color;
colorBtn.innerHTML = "";
colorBtn.appendChild(colorSwatch);
toolbar.appendChild(colorBtn);

// 线宽
const widthBtn = makeBtn("width", "shot.width");
const widthDot = document.createElement("div");
widthDot.className = "width-dot";
widthDot.style.width = `${Math.min(14, 4 + strokeWidth * 2)}px`;
widthDot.style.height = `${Math.min(14, 4 + strokeWidth * 2)}px`;
widthBtn.innerHTML = "";
widthBtn.appendChild(widthDot);
toolbar.appendChild(widthBtn);

// 分隔线
const divider2 = document.createElement("div");
divider2.className = "divider";
toolbar.appendChild(divider2);

const cancelBtn = makeBtn("cancel", "shot.cancel");
cancelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void closeScreenshot();
});
const copyBtn = makeBtn("copy", "shot.copy");
copyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void exportImage("clipboard");
});
const saveBtn = makeBtn("save", "shot.save");
saveBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void exportImage("save");
});
const ocrBtn = makeBtn("ocr", "shot.ocr");
ocrBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void runOcr();
});
toolbar.appendChild(cancelBtn);
toolbar.appendChild(copyBtn);
toolbar.appendChild(saveBtn);
toolbar.appendChild(ocrBtn);

uiLayer.appendChild(toolbar);

// ---------- 颜色面板 ----------
const colorPopup = document.createElement("div");
colorPopup.className = "popup ui-interactive";
{
  const pal = document.createElement("div");
  pal.className = "palette";
  for (const c of PALETTE) {
    const cell = document.createElement("div");
    cell.className = "cell" + (c === color ? " sel" : "");
    cell.style.background = c;
    cell.addEventListener("click", () => {
      color = c;
      colorSwatch.style.background = c;
      syncColorPopup();
      closePopups();
    });
    pal.appendChild(cell);
  }
  const native = document.createElement("input");
  native.type = "color";
  native.className = "native";
  native.value = color;
  native.addEventListener("input", () => {
    color = native.value;
    colorSwatch.style.background = color;
  });
  pal.appendChild(native);
  colorPopup.appendChild(pal);
}
uiLayer.appendChild(colorPopup);

function syncColorPopup() {
  colorPopup.querySelectorAll(".cell").forEach((c) => {
    c.classList.toggle("sel", (c as HTMLElement).style.background === color);
  });
}

// ---------- 线宽面板 ----------
const widthPopup = document.createElement("div");
widthPopup.className = "popup ui-interactive";
{
  const list = document.createElement("div");
  list.className = "width-list";
  for (const w of [2, 4, 6, 10]) {
    const row = document.createElement("div");
    row.className = "row";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = `${w * 3}px`;
    bar.style.height = `${Math.min(12, 2 + w)}px`;
    row.appendChild(bar);
    row.appendChild(document.createTextNode(`${w} px`));
    row.addEventListener("click", () => {
      strokeWidth = w;
      widthDot.style.width = `${Math.min(14, 4 + w * 2)}px`;
      widthDot.style.height = `${Math.min(14, 4 + w * 2)}px`;
      closePopups();
    });
    list.appendChild(row);
  }
  widthPopup.appendChild(list);
}
uiLayer.appendChild(widthPopup);

function closePopups() {
  colorPopup.classList.remove("open");
  widthPopup.classList.remove("open");
}

function setTool(t: Tool | null) {
  tool = t;
  for (const [k, b] of toolBtns) b.classList.toggle("active", k === t);
  if (t !== null) {
    selectedIndex = null;
    closePopups();
  }
  render();
}

// ---------- 文本输入 ----------
const textInput = document.createElement("textarea");
textInput.id = "text-input";
uiLayer.appendChild(textInput);

// ---------- 帮助框 ----------
const helpBox = document.createElement("div");
helpBox.id = "help-box";
helpBox.dataset.i18n = "shot.help";
helpBox.textContent = t("shot.help");
uiLayer.appendChild(helpBox);

// ---------- OCR 结果面板 ----------
const ocrPanel = document.createElement("div");
ocrPanel.id = "ocr-panel";
ocrPanel.className = "ui-interactive";
ocrPanel.style.display = "none";

const ocrHeader = document.createElement("div");
ocrHeader.className = "ocr-header";
const ocrTitle = document.createElement("span");
ocrTitle.className = "ocr-title";
ocrTitle.dataset.i18n = "shot.ocrTitle";
ocrTitle.textContent = t("shot.ocrTitle");
const ocrCopy = makeBtn("copy", "shot.copyAll");
ocrCopy.addEventListener("click", (e) => {
  e.stopPropagation();
  const t = ocrBody.textContent || "";
  if (t) void copyText(t);
});
const ocrClose = makeBtn("cancel", "shot.close");
ocrClose.addEventListener("click", (e) => {
  e.stopPropagation();
  ocrPanel.style.display = "none";
});
ocrHeader.append(ocrTitle, ocrCopy, ocrClose);

const ocrBody = document.createElement("div");
ocrBody.className = "ocr-body";

ocrPanel.append(ocrHeader, ocrBody);
uiLayer.appendChild(ocrPanel);

function positionOcrPanel() {
  if (!selection) return;
  const r = root.getBoundingClientRect();
  const kx = r.width / totalW, ky = r.height / totalH;
  const pw = 320, ph = 220; // 逻辑像素
  let px = selection.x * kx;
  let py = (selection.y + selection.h) * ky + 10;
  if (py + ph > r.height) py = selection.y * ky - ph - 10;
  px = Math.max(8, Math.min(px, r.width - pw - 8));
  py = Math.max(8, Math.min(py, r.height - ph - 8));
  ocrPanel.style.left = `${px}px`;
  ocrPanel.style.top = `${py}px`;
  ocrPanel.style.width = `${pw}px`;
  ocrPanel.style.height = `${ph}px`;
}

function showOcrPanel(text: string, isError = false) {
  ocrBody.textContent = text;
  ocrBody.classList.toggle("error", isError);
  ocrPanel.style.display = "flex";
  positionOcrPanel();
}

// ============================================================
// 几何工具
// ============================================================
function normRect(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function shapeBBox(s: Shape): Rect {
  if (s.tool === "pen" && s.points && s.points.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s.points) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return normRect(s.start, s.end);
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitShape(s: Shape, p: Pt): boolean {
  const tol = 8 * physScale();
  const bb = shapeBBox(s);
  switch (s.tool) {
    case "arrow":
      return distToSegment(p, s.start, s.end) <= tol;
    case "pen":
      if (s.points && s.points.length > 1) {
        for (let i = 0; i < s.points.length - 1; i++) {
          if (distToSegment(p, s.points[i], s.points[i + 1]) <= tol) return true;
        }
        return false;
      }
      return p.x >= bb.x && p.x <= bb.x + bb.w && p.y >= bb.y && p.y <= bb.y + bb.h;
    case "circle": {
      const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
      const a = Math.max(bb.w / 2, 0.1), b = Math.max(bb.h / 2, 0.1);
      const dx = p.x - cx, dy = p.y - cy, dist = Math.hypot(dx, dy);
      if (dist < 0.1 || a < 0.1 || b < 0.1) return false;
      const r = (a * b) / Math.sqrt((b * (dx / dist)) ** 2 + (a * (dy / dist)) ** 2);
      return Math.abs(dist - r) <= tol;
    }
    default:
      return p.x >= bb.x - tol && p.x <= bb.x + bb.w + tol && p.y >= bb.y - tol && p.y <= bb.y + bb.h + tol;
  }
}

function hitTestShapes(p: Pt): number | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitShape(shapes[i], p)) return i;
  }
  return null;
}

// 控制点（物理坐标）
function shapeHandles(s: Shape): Pt[] {
  const bb = shapeBBox(s);
  if (s.tool === "arrow") return [s.start, s.end];
  if (s.tool === "text") {
    return [
      { x: bb.x, y: bb.y },
      { x: bb.x + bb.w, y: bb.y },
      { x: bb.x + bb.w, y: bb.y + bb.h },
      { x: bb.x, y: bb.y + bb.h },
    ];
  }
  const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
  return [
    { x: bb.x, y: bb.y },
    { x: bb.x + bb.w, y: bb.y },
    { x: bb.x + bb.w, y: bb.y + bb.h },
    { x: bb.x, y: bb.y + bb.h },
    { x: cx, y: bb.y },
    { x: bb.x + bb.w, y: cy },
    { x: cx, y: bb.y + bb.h },
    { x: bb.x, y: cy },
  ];
}

function hitHandle(p: Pt): { index: number; handle: number } | null {
  if (selectedIndex == null) return null;
  const s = shapes[selectedIndex];
  if (!s) return null;
  const handles = shapeHandles(s);
  for (let i = 0; i < handles.length; i++) {
    if (Math.hypot(p.x - handles[i].x, p.y - handles[i].y) <= HANDLE_HIT) {
      return { index: selectedIndex, handle: i };
    }
  }
  return null;
}

// ============================================================
// 绘制
// ============================================================
function drawArrowShape(c: CanvasRenderingContext2D, start: Pt, end: Pt, sw: number) {
  c.beginPath();
  c.moveTo(start.x, start.y);
  c.lineTo(end.x, end.y);
  c.stroke();
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const ux = dx / len, uy = dy / len;
  const asz = (12 + sw * 2) * physScale();
  const px = -uy * asz * 0.5, py = ux * asz * 0.5;
  c.beginPath();
  c.moveTo(end.x - ux * asz + px, end.y - uy * asz + py);
  c.lineTo(end.x, end.y);
  c.lineTo(end.x - ux * asz - px, end.y - uy * asz - py);
  c.stroke();
}

function textFontSize(s: Shape): number {
  return (20 + s.strokeWidth * 2) * physScale();
}

function drawShape(c: CanvasRenderingContext2D, s: Shape) {
  const sw = s.strokeWidth * physScale();
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.lineWidth = sw;
  c.lineCap = "round";
  c.lineJoin = "round";

  const bb = shapeBBox(s);
  switch (s.tool) {
    case "rect":
      c.strokeRect(bb.x, bb.y, bb.w, bb.h);
      break;
    case "circle":
      c.beginPath();
      c.ellipse(bb.x + bb.w / 2, bb.y + bb.h / 2, bb.w / 2, bb.h / 2, 0, 0, Math.PI * 2);
      c.stroke();
      break;
    case "arrow":
      drawArrowShape(c, s.start, s.end, sw);
      break;
    case "pen":
      if (s.points && s.points.length > 1) {
        c.beginPath();
        c.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) c.lineTo(s.points[i].x, s.points[i].y);
        c.stroke();
      }
      break;
    case "text": {
      const fs = textFontSize(s);
      c.font = `600 ${fs}px "Segoe UI", system-ui, sans-serif`;
      c.textBaseline = "top";
      const lh = fs * 1.2;
      (s.text || "").split("\n").forEach((ln, i) => {
        c.fillText(ln, s.start.x, s.start.y + i * lh);
      });
      break;
    }
    case "mosaic":
      // 马赛克单独用采样绘制
      break;
  }
}

function drawMosaic(c: CanvasRenderingContext2D, bb: Rect, block: number) {
  if (bb.w <= 0 || bb.h <= 0) return;
  const bw = Math.max(1, Math.round(bb.w / block));
  const bh = Math.max(1, Math.round(bb.h / block));
  const tmp = document.createElement("canvas");
  tmp.width = bw;
  tmp.height = bh;
  const tc = tmp.getContext("2d")!;
  blitRegion(tc, bb.x, bb.y, bb.w, bb.h, 0, 0, bw, bh);
  c.save();
  c.imageSmoothingEnabled = false;
  c.drawImage(tmp, bb.x, bb.y, bb.w, bb.h);
  c.restore();
}

// 从多屏截图采样一块区域，绘制到目标矩形（用于马赛克与导出）
function blitRegion(
  dst: CanvasRenderingContext2D,
  sx: number, sy: number, sw: number, sh: number,
  dx: number, dy: number, dw: number, dh: number,
) {
  dst.save();
  dst.beginPath();
  dst.rect(dx, dy, dw, dh);
  dst.clip();
  dst.imageSmoothingEnabled = true;
  for (const s of screens) {
    const ox = Math.max(sx, s.x), oy = Math.max(sy, s.y);
    const ex = Math.min(sx + sw, s.x + s.w), ey = Math.min(sy + sh, s.y + s.h);
    if (ox >= ex || oy >= ey) continue;
    const sxr = dw / sw, syr = dh / sh;
    dst.drawImage(
      s.img,
      ox - s.x, oy - s.y, ex - ox, ey - oy,
      dx + (ox - sx) * sxr, dy + (oy - sy) * syr, (ex - ox) * sxr, (ey - oy) * syr,
    );
  }
  dst.restore();
}

function render() {
  const r = root.getBoundingClientRect();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 遮罩：有选区/拖动时，选区外变暗
  const selRect = dragMode === "select" && dragStart && dragCur
    ? normRect(dragStart, dragCur)
    : selection;
  if (selRect && selRect.w > 0 && selRect.h > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.clearRect(selRect.x, selRect.y, selRect.w, selRect.h);
  }

  // 图形
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    if (s.tool === "mosaic") drawMosaic(ctx, shapeBBox(s), mosaicWidth);
    else drawShape(ctx, s);
  }

  // 当前绘制中的图形
  if (curShape) {
    if (curShape.tool === "mosaic") drawMosaic(ctx, shapeBBox(curShape), mosaicWidth);
    else drawShape(ctx, curShape);
  }

  // 选区边框（绿色 + 8 锚点）
  if (selection && selection.w > 0 && selection.h > 0) {
    drawStyleBox(ctx, selection);
  }

  // 选中图形的控制点 + 蓝色边框
  if (selectedIndex != null && shapes[selectedIndex]) {
    const s = shapes[selectedIndex];
    const bb = shapeBBox(s);
    ctx.strokeStyle = "#0096ff";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bb.x - 2, bb.y - 2, bb.w + 4, bb.h + 4);
    for (const h of shapeHandles(s)) {
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#3c3c3c";
      ctx.lineWidth = 1;
      ctx.fillRect(h.x - 5 * physScale(), h.y - 5 * physScale(), 10 * physScale(), 10 * physScale());
      ctx.strokeRect(h.x - 5 * physScale(), h.y - 5 * physScale(), 10 * physScale(), 10 * physScale());
    }
  }

  // 尺寸标签
  if (selRect && selRect.w > 0) {
    const label = `${Math.round(selRect.w)} × ${Math.round(selRect.h)}`;
    const fs = 12 * physScale();
    ctx.font = `${fs}px "Segoe UI", sans-serif`;
    const tw = ctx.measureText(label).width;
    let lx = selRect.x;
    let ly = selRect.y - fs - 12 * physScale();
    if (ly < 4 * physScale()) ly = selRect.y + 8 * physScale();
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(lx, ly, tw + 12 * physScale(), fs + 8 * physScale());
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "top";
    ctx.fillText(label, lx + 6 * physScale(), ly + 4 * physScale());
  }

  // 工具栏定位
  if (selection) {
    toolbar.style.display = "flex";
    const tbW = toolbar.offsetWidth || 360;
    const tbH = toolbar.offsetHeight || 44;
    const rw = r.width, rh = r.height;
    const kx = rw / totalW, ky = rh / totalH;
    let tx = (selection.x + selection.w) * kx - tbW;
    let ty = (selection.y + selection.h) * ky + 10;
    if (ty + tbH > rh) ty = selection.y * ky - tbH - 10;
    tx = Math.max(8, Math.min(tx, rw - tbW - 8));
    ty = Math.max(8, Math.min(ty, rh - tbH - 8));
    toolbar.style.left = `${tx}px`;
    toolbar.style.top = `${ty}px`;
  } else {
    toolbar.style.display = "none";
  }

  // OCR 面板跟随选区 —— 选区移动/重选时同步刷新位置（之前只 showOcrPanel 调一次）。
  if (selection && ocrPanel.style.display !== "none") {
    positionOcrPanel();
  }

  // 放大镜（跟随光标，悬停于 UI 上时不显示）
  if (magnifierActive && lastMousePos && !overUI) {
    drawMagnifier(ctx, lastMousePos.x, lastMousePos.y);
  }
}

function drawStyleBox(c: CanvasRenderingContext2D, r: Rect) {
  c.strokeStyle = "#00ff00";
  c.lineWidth = 1;
  c.strokeRect(r.x, r.y, r.w, r.h);
  const asz = 6 * physScale();
  if (r.w > asz * 3 && r.h > asz * 3) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const pts = [
      [r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h],
      [cx, r.y], [cx, r.y + r.h], [r.x, cy], [r.x + r.w, cy],
    ];
    c.fillStyle = "#00ff00";
    for (const [px, py] of pts) c.fillRect(px - asz / 2, py - asz / 2, asz, asz);
  }
}

// ============================================================
// 放大镜
// ============================================================
const magTemp = document.createElement("canvas");
magTemp.width = MAG_GRID;
magTemp.height = MAG_GRID;
const magTempCtx = magTemp.getContext("2d")!;

function sampleMagnifier(cx: number, cy: number): Uint8ClampedArray | null {
  const half = Math.floor(MAG_GRID / 2);
  const sx = Math.round(cx) - half;
  const sy = Math.round(cy) - half;
  magTempCtx.clearRect(0, 0, MAG_GRID, MAG_GRID);
  blitRegion(magTempCtx, sx, sy, MAG_GRID, MAG_GRID, 0, 0, MAG_GRID, MAG_GRID);
  try {
    return magTempCtx.getImageData(0, 0, MAG_GRID, MAG_GRID).data;
  } catch {
    return null;
  }
}

function centerColorHex(data: Uint8ClampedArray): string {
  const half = Math.floor(MAG_GRID / 2);
  const i = (half * MAG_GRID + half) * 4;
  const r = data[i], g = data[i + 1], b = data[i + 2];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function drawMagnifier(c: CanvasRenderingContext2D, px: number, py: number) {
  const data = sampleMagnifier(px, py);
  if (!data) return;

  const half = Math.floor(MAG_GRID / 2);
  const gridLog = MAG_GRID * MAG_PIXEL; // 150 逻辑像素
  const r = root.getBoundingClientRect();
  const kx = r.width / totalW, ky = r.height / totalH;

  // 光标逻辑坐标
  const cx = px * kx;
  const cy = py * ky;

  // 卡片位置（逻辑像素），靠近边缘翻转
  let cardX = cx + MAG_OFFSET;
  let cardY = cy + MAG_OFFSET;
  const cardW = gridLog;
  const cardH = gridLog + MAG_INFO_H;
  if (cardX + cardW > r.width) cardX = cx - MAG_OFFSET - cardW;
  if (cardY + cardH > r.height) cardY = cy - MAG_OFFSET - cardH;

  // 物理 → CSS
  const s = r.width / totalW;
  const ps = (v: number) => v / s;

  c.save();
  c.setLineDash([]);

  // 卡片背景
  c.fillStyle = "#ffffff";
  roundRect(c, ps(cardX), ps(cardY), ps(cardW), ps(cardH), 4 * physScale());
  c.fill();

  // 15×15 像素块
  const block = ps(MAG_PIXEL);
  for (let gy = 0; gy < MAG_GRID; gy++) {
    for (let gx = 0; gx < MAG_GRID; gx++) {
      const i = (gy * MAG_GRID + gx) * 4;
      c.fillStyle = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
      c.fillRect(ps(cardX) + gx * block, ps(cardY) + gy * block, block, block);
    }
  }

  // 网格线
  c.strokeStyle = "rgba(0,0,0,0.31)";
  c.lineWidth = 1;
  c.beginPath();
  for (let i = 1; i < MAG_GRID; i++) {
    const v = ps(cardX) + i * block;
    c.moveTo(v, ps(cardY));
    c.lineTo(v, ps(cardY) + ps(gridLog));
    const h = ps(cardY) + i * block;
    c.moveTo(ps(cardX), h);
    c.lineTo(ps(cardX) + ps(gridLog), h);
  }
  c.stroke();

  // 中心十字准星
  const centerBlockX = ps(cardX) + half * block;
  const centerBlockY = ps(cardY) + half * block;
  c.strokeStyle = "#00ffff";
  c.lineWidth = 1.5 * physScale();
  c.strokeRect(centerBlockX, centerBlockY, block, block);
  c.strokeStyle = "rgba(0,255,255,0.4)";
  c.lineWidth = 1;
  c.beginPath();
  const mgCx = ps(cardX) + ps(gridLog) / 2;
  const mgCy = ps(cardY) + ps(gridLog) / 2;
  c.moveTo(ps(cardX), mgCy); c.lineTo(ps(cardX) + ps(gridLog), mgCy);
  c.moveTo(mgCx, ps(cardY)); c.lineTo(mgCx, ps(cardY) + ps(gridLog));
  c.stroke();

  // 信息栏
  const infoY = ps(cardY) + ps(gridLog);
  const infoH = ps(MAG_INFO_H);
  c.strokeStyle = "#e6e6e6";
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(ps(cardX), infoY);
  c.lineTo(ps(cardX) + ps(cardW), infoY);
  c.stroke();

  const hex = centerColorHex(data);
  const rowH = infoH / 3;
  const pad = 8 * physScale();
  c.textBaseline = "middle";
  c.fillStyle = "#282828";
  c.font = `${12 * physScale()}px "Segoe UI", sans-serif`;
  c.textAlign = "left";
  c.fillText(`(${Math.round(px)}, ${Math.round(py)})`, ps(cardX) + pad, infoY + rowH * 0.5 + 2 * physScale());

  const recently = performance.now() - copiedAt < 1500;
  const row2Text = recently ? t("shot.copied") : hex;
  const row2Color = recently ? "#28a03c" : "#282828";
  c.fillStyle = row2Color;
  c.fillText(row2Text, ps(cardX) + pad, infoY + rowH * 1.5 + 2 * physScale());

  // 色块预览
  const textW = c.measureText(row2Text).width;
  const prevSize = 12 * physScale();
  const prevX = ps(cardX) + pad + textW + 8 * physScale();
  const prevY = infoY + rowH * 1.5 + 2 * physScale();
  c.fillStyle = hex;
  roundRect(c, prevX, prevY - prevSize / 2, prevSize, prevSize, 2 * physScale());
  c.fill();
  c.strokeStyle = "#c8c8c8";
  c.lineWidth = 1;
  c.strokeRect(prevX, prevY - prevSize / 2, prevSize, prevSize);

  // 复制提示
  c.fillStyle = "#969696";
  c.font = `${10 * physScale()}px "Segoe UI", sans-serif`;
  c.fillText(t("shot.copyColorHint", { key: copyColorHotkey }), ps(cardX) + pad, infoY + rowH * 2.5);

  c.restore();
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

// ============================================================
// 坐标换算
// ============================================================
function physPos(e: MouseEvent): Pt {
  const r = root.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (totalW / r.width),
    y: (e.clientY - r.top) * (totalH / r.height),
  };
}

/// 将位置限制在选区内（移植自 egui 版 shape.rs clamp_pos_to_rect；
/// 无选区时不限制 —— 与原版 Rect::EVERYTHING 语义一致）
function clampToSelection(p: Pt): Pt {
  if (!selection) return p;
  return {
    x: Math.min(Math.max(p.x, selection.x), selection.x + selection.w),
    y: Math.min(Math.max(p.y, selection.y), selection.y + selection.h),
  };
}

// ============================================================
// 历史
// ============================================================
function pushHistory() {
  undoStack.push(shapes.map(cloneShape));
  if (undoStack.length > 50) undoStack.shift();
  redoStack = [];
}

function cloneShape(s: Shape): Shape {
  return { ...s, points: s.points ? s.points.map((p) => ({ ...p })) : undefined };
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(shapes.map(cloneShape));
  shapes = undoStack.pop()!;
  selectedIndex = null;
  render();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(shapes.map(cloneShape));
  shapes = redoStack.pop()!;
  selectedIndex = null;
  render();
}

// ============================================================
// 鼠标交互
// ============================================================
function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  if (textInput.classList.contains("editing")) return;
  const p = physPos(e);

  // 1. 控制点缩放
  const h = hitHandle(p);
  if (h) {
    dragMode = "resize";
    resizeHandle = h.handle;
    const s = shapes[h.index];
    resizeOrig = { start: { ...s.start }, end: { ...s.end }, strokeWidth: s.strokeWidth };
    return;
  }

  // 2. 命中图形 → 选中 + 移动
  const hit = hitTestShapes(p);
  if (hit != null) {
    selectedIndex = hit;
    dragMode = "move";
    moveStart = p;
    moveOrigShape = cloneShape(shapes[hit]);
    render();
    return;
  }

  // 3. 有工具 → 开始绘制（起点 clamp 到选区内 —— 原版 clamp_pos_to_rect 行为）
  if (tool) {
    selectedIndex = null;
    dragMode = "none";
    if (tool === "text") {
      showTextInput(clampToSelection(p));
      return;
    }
    const cp = clampToSelection(p);
    curShape = {
      tool,
      start: { ...cp },
      end: { ...cp },
      color,
      strokeWidth: tool === "mosaic" ? mosaicWidth : strokeWidth,
      points: tool === "pen" ? [{ ...cp }] : undefined,
    };
    render();
    return;
  }

  // 4. 无工具 → 开始选区拖动
  selectedIndex = null;
  dragMode = "select";
  dragStart = { ...p };
  dragCur = { ...p };
  render();
}

function onMouseMove(e: MouseEvent) {
  const p = physPos(e);

  // 放大镜跟随 + 悬停 UI 检测
  lastMousePos = p;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  overUI = !!el && !!(el as HTMLElement).closest?.(".toolbar, .popup, #text-input, #ocr-panel");

  if (dragMode === "select") {
    dragCur = p;
    render();
    return;
  }
  if (dragMode === "move" && moveStart && moveOrigShape && selectedIndex != null) {
    // 移动也 clamp：算出移动后的 bbox，把 delta 收敛到选区内（原版 move_shape 行为）
    const dx = p.x - moveStart.x, dy = p.y - moveStart.y;
    const orig = moveOrigShape;
    let ddx = dx, ddy = dy;
    if (selection) {
      const selR = selection;
      const minX0 = Math.min(orig.start.x, orig.end.x), maxX0 = Math.max(orig.start.x, orig.end.x);
      const minY0 = Math.min(orig.start.y, orig.end.y), maxY0 = Math.max(orig.start.y, orig.end.y);
      if (minX0 + dx < selR.x) ddx = selR.x - minX0;
      if (maxX0 + dx > selR.x + selR.w) ddx = selR.x + selR.w - maxX0;
      if (minY0 + dy < selR.y) ddy = selR.y - minY0;
      if (maxY0 + dy > selR.y + selR.h) ddy = selR.y + selR.h - maxY0;
    }
    const s = shapes[selectedIndex];
    s.start = { x: orig.start.x + ddx, y: orig.start.y + ddy };
    s.end = { x: orig.end.x + ddx, y: orig.end.y + ddy };
    if (s.points && orig.points) {
      s.points = orig.points.map((q) => ({ x: q.x + ddx, y: q.y + ddy }));
    }
    render();
    return;
  }
  if (dragMode === "resize" && resizeOrig && selectedIndex != null) {
    // 缩放的控制点也 clamp 到选区（原版 apply_resize 行为）
    applyResize(shapes[selectedIndex], resizeHandle, clampToSelection(p));
    render();
    return;
  }

  // 绘制中（终点/笔迹点 clamp 到选区 —— 原版 drag.rs 行为）
  if (curShape) {
    const cp = clampToSelection(p);
    curShape.end = cp;
    if (curShape.tool === "pen" && curShape.points) {
      // 与原版一致：距上一点 > 2 物理像素才记录，避免密集采样
      const last = curShape.points[curShape.points.length - 1];
      if (!last || Math.hypot(cp.x - last.x, cp.y - last.y) > 2) {
        curShape.points.push({ ...cp });
      }
    }
    render();
    return;
  }

  // 悬停
  const hit = hitTestShapes(p);
  if (hit !== hoverIndex) {
    hoverIndex = hit;
    canvas.style.cursor = hit != null ? "move" : "crosshair";
  }

  // 无拖拽/绘制分支命中时也要重绘：放大镜跟随鼠标 + overUI 切换都需要刷新。
  // （原版 egui 是 immediate mode 每帧重绘，Tauri 版必须显式触发）
  render();
}

function onMouseUp(e: MouseEvent) {
  if (e.button !== 0) return;

  if (dragMode === "select") {
    const r = dragStart && dragCur ? normRect(dragStart, dragCur) : null;
    if (r && r.w >= MIN_SHAPE_SIZE && r.h >= MIN_SHAPE_SIZE) {
      selection = r;
    } else {
      selection = null;
    }
    dragStart = dragCur = null;
    dragMode = "none";
    render();
    return;
  }

  if (dragMode === "move") {
    if (moveOrigShape) {
      // 有实际位移才记历史
      const s = shapes[selectedIndex!];
      if (s.start.x !== moveOrigShape.start.x || s.start.y !== moveOrigShape.start.y) {
        undoStack.push(shapes.map(cloneShape));
        redoStack = [];
      }
    }
    dragMode = "none";
    moveStart = null;
    moveOrigShape = null;
    render();
    return;
  }

  if (dragMode === "resize") {
    dragMode = "none";
    resizeHandle = -1;
    resizeOrig = null;
    render();
    return;
  }

  if (curShape) {
    const s = curShape;
    curShape = null;
    const bb = shapeBBox(s);
    if (bb.w >= MIN_SHAPE_SIZE && bb.h >= MIN_SHAPE_SIZE) {
      pushHistory();
      shapes.push(s);
    }
    render();
    return;
  }
}

// ---------- 缩放 ----------
function applyResize(s: Shape, handle: number, p: Pt) {
  if (!resizeOrig) return;
  const o = resizeOrig;
  let ns: Pt, ne: Pt;
  if (s.tool === "arrow") {
    if (handle === 0) { ns = p; ne = o.end; }
    else { ns = o.start; ne = p; }
  } else if (s.tool === "text") {
    // 4 角控制点
    const corners = [
      { x: o.start.x, y: o.start.y }, { x: o.end.x, y: o.start.y },
      { x: o.end.x, y: o.end.y }, { x: o.start.x, y: o.end.y },
    ];
    const c = corners[handle] ?? corners[0];
    ns = { x: Math.min(c.x, p.x), y: Math.min(c.y, p.y) };
    ne = { x: Math.max(c.x, p.x), y: Math.max(c.y, p.y) };
  } else {
    // 8 控制点（与原版 mapping 一致）
    switch (handle) {
      case 0: ns = p; ne = o.end; break;
      case 1: ns = { x: o.start.x, y: p.y }; ne = { x: p.x, y: o.end.y }; break;
      case 2: ns = o.start; ne = p; break;
      case 3: ns = { x: p.x, y: o.start.y }; ne = { x: o.end.x, y: p.y }; break;
      case 4: ns = { x: o.start.x, y: p.y }; ne = o.end; break;
      case 5: ns = o.start; ne = { x: p.x, y: o.end.y }; break;
      case 6: ns = o.start; ne = { x: o.end.x, y: p.y }; break;
      case 7: ns = { x: p.x, y: o.start.y }; ne = o.end; break;
      default: ns = o.start; ne = o.end;
    }
  }

  const w = Math.abs(ne.x - ns.x), h = Math.abs(ne.y - ns.y);
  if (w < MIN_SHAPE_SIZE || h < MIN_SHAPE_SIZE) return;

  if (s.tool === "text") {
    const prevW = Math.abs(o.end.x - o.start.x);
    if (prevW > 1) {
      const sw = Math.max(1, Math.min(48, o.strokeWidth * (w / prevW)));
      s.strokeWidth = sw;
    }
  }
  s.start = ns;
  s.end = ne;
}

// ---------- 文本输入 ----------
function showTextInput(p: Pt) {
  const r = root.getBoundingClientRect();
  const kx = r.width / totalW, ky = r.height / totalH;
  const lx = p.x * kx, ly = p.y * ky;
  const fs = 20 + strokeWidth * 2;
  textInput.value = "";
  textInput.style.left = `${lx}px`;
  textInput.style.top = `${ly}px`;
  textInput.style.color = color;
  textInput.style.fontSize = `${fs}px`;
  textInput.classList.add("editing");
  textInput.focus();
}

function commitText() {
  if (!textInput.classList.contains("editing")) return;
  const val = textInput.value.replace(/\r/g, "");
  textInput.classList.remove("editing");
  if (!val.trim()) return;

  const r = root.getBoundingClientRect();
  const kx = totalW / r.width, ky = totalH / r.height;
  const sx = parseFloat(textInput.style.left) * kx;
  const sy = parseFloat(textInput.style.top) * ky;
  const fs = (20 + strokeWidth * 2) * physScale();
  ctx.font = `600 ${fs}px "Segoe UI", system-ui, sans-serif`;
  const lines = val.split("\n");
  const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const textH = lines.length * fs * 1.2;

  pushHistory();
  shapes.push({
    tool: "text",
    start: { x: sx, y: sy },
    end: { x: sx + maxW, y: sy + textH },
    color,
    strokeWidth,
    text: val,
  });
  render();
}

textInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    commitText();
  } else if (e.key === "Escape") {
    e.preventDefault();
    textInput.classList.remove("editing");
  }
});
textInput.addEventListener("blur", commitText);

// ============================================================
// 键盘
// ============================================================

// 取色热键（读 config.hotkeys.copy_color，main() 里覆盖；与后端默认一致）
let copyColorHotkey = "Alt+C";

interface ParsedHotkey {
  ctrl: boolean; // Ctrl/Cmd 语义：匹配 ctrlKey 或 metaKey
  alt: boolean;
  shift: boolean;
  key: string; // 小写主键
}

function parseHotkey(s: string): ParsedHotkey | null {
  const parts = s.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const acc: ParsedHotkey = { ctrl: false, alt: false, shift: false, key: "" };
  for (const p of parts) {
    const lp = p.toLowerCase();
    if (lp === "ctrl" || lp === "control" || lp === "cmd" || lp === "meta" || lp === "super" || lp === "cmdorctrl") {
      acc.ctrl = true;
    } else if (lp === "alt") {
      acc.alt = true;
    } else if (lp === "shift") {
      acc.shift = true;
    } else {
      acc.key = lp;
    }
  }
  return acc.key ? acc : null;
}

function matchesHotkey(e: KeyboardEvent, h: ParsedHotkey): boolean {
  const ctrlOk = h.ctrl ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.metaKey;
  return (
    ctrlOk &&
    (h.alt ? e.altKey : !e.altKey) &&
    (h.shift ? e.shiftKey : !e.shiftKey) &&
    e.key.toLowerCase() === h.key
  );
}

window.addEventListener("keydown", (e) => {
  if (textInput.classList.contains("editing")) return;

  if (e.key === "Escape") {
    void closeScreenshot();
  } else if (e.key === "Enter") {
    if (selection && selection.w > 0) void exportImage("clipboard");
  } else if (matchesHotkey(e, parseHotkey(copyColorHotkey) ?? { ctrl: true, alt: false, shift: false, key: "c" })) {
    // 放大镜取色：复制中心像素十六进制色值
    if (magnifierActive && lastMousePos && !overUI) {
      const data = sampleMagnifier(lastMousePos.x, lastMousePos.y);
      if (data) {
        e.preventDefault();
        const hex = centerColorHex(data);
        void copyText(hex);
        copiedAt = performance.now();
        render();
      }
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (selectedIndex != null) {
      pushHistory();
      shapes.splice(selectedIndex, 1);
      selectedIndex = null;
      render();
    }
  }
});

// 阻止浏览器默认右键菜单
window.addEventListener("contextmenu", (e) => e.preventDefault());

// ============================================================
// 导出
// ============================================================
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve((fr.result as string).split(",")[1] || "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function exportImage(action: "save" | "clipboard") {
  if (!selection || selection.w <= 0 || selection.h <= 0) return;
  const sel = selection;
  const out = document.createElement("canvas");
  out.width = Math.round(sel.w);
  out.height = Math.round(sel.h);
  const oc = out.getContext("2d")!;
  oc.imageSmoothingEnabled = true;

  // 1. 裁剪多屏截图
  blitRegion(oc, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height);

  // 2. 平移后重绘标注
  oc.save();
  oc.translate(-sel.x, -sel.y);
  for (const s of shapes) {
    if (s.tool === "mosaic") drawMosaic(oc, shapeBBox(s), mosaicWidth);
    else drawShape(oc, s);
  }
  oc.restore();

  const blob = await new Promise<Blob>((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
  const b64 = await blobToBase64(blob);
  await finishScreenshot(action, b64);
}

// ============================================================
// OCR
// ============================================================
let ocrBusy = false;

async function runOcr() {
  if (!selection || selection.w <= 0 || selection.h <= 0 || ocrBusy) return;
  const sel = selection;

  // 裁剪原始截图（不含标注，避免线条/马赛克干扰识别）
  const out = document.createElement("canvas");
  out.width = Math.round(sel.w);
  out.height = Math.round(sel.h);
  const oc = out.getContext("2d")!;
  oc.imageSmoothingEnabled = true;
  blitRegion(oc, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height);

  const blob = await new Promise<Blob>((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
  const b64 = await blobToBase64(blob);

  ocrBusy = true;
  showOcrPanel(t("shot.ocrRecognizing"));
  try {
    const text = await ocrImage(b64);
    showOcrPanel(text.trim() || t("shot.ocrEmpty"));
  } catch (err) {
    showOcrPanel(t("shot.ocrFailed", { msg: String(err) }), true);
  } finally {
    ocrBusy = false;
  }
}

// ============================================================
// 事件绑定 + 初始化
// ============================================================
canvas.addEventListener("mousedown", onMouseDown);
window.addEventListener("mousemove", onMouseMove);
window.addEventListener("mouseup", onMouseUp);

colorBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = colorPopup.classList.contains("open");
  closePopups();
  if (!open) {
    syncColorPopup();
    const r = colorBtn.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    colorPopup.style.left = `${r.left - rr.left - 80}px`;
    colorPopup.style.top = `${r.bottom - rr.top + 6}px`;
    colorPopup.classList.add("open");
  }
});
widthBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = widthPopup.classList.contains("open");
  closePopups();
  if (!open) {
    const r = widthBtn.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    widthPopup.style.left = `${r.left - rr.left - 40}px`;
    widthPopup.style.top = `${r.bottom - rr.top + 6}px`;
    widthPopup.classList.add("open");
  }
});
// 点击弹窗/切换按钮以外的地方时关闭弹窗
window.addEventListener("mousedown", (e) => {
  const t = e.target as Node;
  if (colorPopup.contains(t) || widthPopup.contains(t) || colorBtn.contains(t) || widthBtn.contains(t)) {
    return;
  }
  closePopups();
});

async function loadScreenshot() {
  const data = await getScreenshotData();
  if (!data) {
    await closeScreenshot();
    return;
  }

  // 清旧状态（旧 img 元素 + 标注历史）
  root.querySelectorAll("img").forEach((el) => el.remove());
  shapes = [];
  undoStack = [];
  redoStack = [];
  selection = null;
  dragStart = dragCur = null;
  dragMode = "none";
  curShape = null;
  selectedIndex = null;
  hoverIndex = null;
  moveStart = null;
  moveOrigShape = null;
  resizeOrig = null;
  resizeHandle = -1;
  textInput.classList.remove("editing");
  ocrPanel.style.display = "none";
  screens = [];

  totalW = data.total_width;
  totalH = data.total_height;
  minX = data.min_x;
  minY = data.min_y;

  canvas.width = totalW;
  canvas.height = totalH;

  // 拼接多屏截图（定位到虚拟桌面逻辑坐标）
  for (const s of data.screens) {
    const img = document.createElement("img");
    img.src = s.data_url;
    img.style.left = `${(s.x - minX) / physScale()}px`;
    img.style.top = `${(s.y - minY) / physScale()}px`;
    img.style.width = `${s.width / physScale()}px`;
    img.style.height = `${s.height / physScale()}px`;
    root.insertBefore(img, canvas);
    screens.push({ img, x: s.x, y: s.y, w: s.width, h: s.height });
  }

  console.info(
    "[screenshot] bounds", data.min_x, data.min_y, data.total_width, data.total_height,
    "scale", physScale().toFixed(2), "screens", data.screens.length,
  );

  render();
}

async function main() {
  // 读配置（每次刷新都要重新读，比如用户切换了语言/取色热键）
  try {
    const cfg = await getConfig();
    magnifierActive = cfg.magnifier_enabled;
    setLang(cfg.language);
    if (cfg.hotkeys?.copy_color) copyColorHotkey = cfg.hotkeys.copy_color;
  } catch {
    // 读配置失败则保持默认
  }
  applyI18n(document);

  // 后端复用窗口时 main() 不会重跑，但会 emit screenshot-refresh 触发 loadScreenshot
  await listen("screenshot-refresh", () => {
    void loadScreenshot();
  });

  await loadScreenshot();
}

void main();

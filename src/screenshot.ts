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

type DragMode = "none" | "select" | "move" | "resize" | "move-selection";
let dragMode: DragMode = "none";
let resizeHandle = -1;
let moveStart: Pt | null = null;
let moveOrigShape: Shape | null = null;
let resizeOrig: { start: Pt; end: Pt; strokeWidth: number } | null = null;
let moveSelectionStart: Pt | null = null;
let moveSelectionOrig: Rect | null = null;

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
  rect: '<rect x="4" y="5" width="16" height="14" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  // 双向端帽（贴齐 egui paint_arrow_icon：line + end 两侧各一段短斜线）
  arrow: '<path d="M5 19 L19 5 M13 5 H19 V11"/>',
  // 正弦波笔触（贴齐 egui paint_pencil_icon：base_y + sin(t·π·2.5)·h·0.25）。
  // SVG 里用 3 段 Q/T 沿 x 等距升高抄此几何，比 lucide 钢笔更"画线"而
  // 不是"持笔"。
  pen: '<path d="M4 19 Q 6 7 8.5 13 T 12 12 T 15.5 13 T 20 5"/>',
  // 马赛克：对角填充（左上 + 右下 fill="currentColor" stroke="none"），
  // 另两角只描边（fill="none"），与原版 egui `paint_mosaic_icon` 的对角逻辑一致。
  mosaic:
    '<rect x="4" y="4" width="7" height="7" rx="1" fill="none"/>' +
    '<rect x="13" y="4" width="7" height="7" rx="1" fill="none"/>' +
    '<rect x="4" y="13" width="7" height="7" rx="1" fill="none"/>' +
    '<rect x="13" y="13" width="7" height="7" rx="1" fill="none"/>' +
    '<rect x="4" y="4" width="7" height="7" rx="1" fill="currentColor" stroke="none"/>' +
    '<rect x="13" y="13" width="7" height="7" rx="1" fill="currentColor" stroke="none"/>',
  // 仅 T（贴齐 egui `paint_text_icon`：顶横 + 中竖，无底横脚）
  text: '<path d="M5 5 V3 H19 V5 M12 3 V21"/>',
  cancel: '<path d="M6 6 L18 18 M18 6 L6 18"/>',
  // 双错位矩形 + 前层 fill="#fff"（白底覆盖，露出后层轮廓；工具栏白底背景下成立）
  copy:
    '<rect x="8" y="8" width="11" height="11" rx="1.5" fill="none"/>' +
    '<rect x="5" y="5" width="11" height="11" rx="1.5" fill="#ffffff" stroke="none"/>' +
    '<rect x="5" y="5" width="11" height="11" rx="1.5"/>',
  // 保存：向下箭落入开口托盘（lucide download 风格），一眼即“保存/落盘”
  save:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<path d="M7 10l5 5 5-5"/>' +
    '<path d="M12 15V3"/>',
  ocr: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M7 9 H17 M7 13 H14 M7 17 H17"/>',
  // 重新截图：刷新环箭头（lucide rotate-cw 风格），点它清空选区回到拉框
  reselect: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
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
    // 点同一工具 → 取消（toggle off）；点别的工具 → 切换。
    // toggle off 不会清除选区/已画图形，只是把光标交回选区模式。
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

// 重新截图：清空选区回到拉框状态（微信式交互的出口）
const reselectBtn = makeBtn("reselect", "shot.reselect");
reselectBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  selection = null;
  selectedIndex = null;
  setTool(null);
  render();
});
toolbar.appendChild(reselectBtn);

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
  // pen / mosaic 都用 points 数组定位（mosaic 现在是笔刷式：每个 point 涂一个 bs×bs 的块）
  if ((s.tool === "pen" || s.tool === "mosaic") && s.points && s.points.length) {
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

// block 是**逻辑像素**的块边长（与原版 egui 的 mosaic_width 同义），
// 内部转物理像素再切块：原版 block_size_phys = mosaic_width * ppp。
// 之前直接拿 16 当物理像素用，150% DPI 下块只有原版 2/3 大（糊得不够）。
// mosaic 现在是**笔刷式**：跟 pen 一样按 points 数组画笔触，
// 每个 point 处涂一个 bs×bs 的方块，块的颜色取自源区域 down-sample 到 1×1 的代表色。
// 相邻点 > bs 时插值填块，避免快速拖动时出现笔触裂缝。
function drawMosaic(c: CanvasRenderingContext2D, s: Shape) {
  const points = s.points;
  if (!points || points.length === 0) return;
  const block = s.strokeWidth || mosaicWidth;
  const bs = Math.max(1, Math.round(block * physScale())); // 每块边长（物理像素）
  const tmp = document.createElement("canvas");
  tmp.width = 1;
  tmp.height = 1;
  const tc = tmp.getContext("2d")!;
  const paintDot = (px: number, py: number) => {
    const dx = px - bs / 2;
    const dy = py - bs / 2;
    blitRegion(tc, dx, dy, bs, bs, 0, 0, 1, 1);
    const d = tc.getImageData(0, 0, 1, 1).data;
    c.fillStyle = `rgba(${d[0]},${d[1]},${d[2]},${(d[3] / 255).toFixed(3)})`;
    c.fillRect(dx, dy, bs, bs);
  };
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    paintDot(cur.x, cur.y);
    if (i > 0) {
      const prev = points[i - 1];
      const dist = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (dist > bs) {
        // 相邻两点之间补块（避免快速拖动时块间距过大产生的可见空隙）
        const steps = Math.max(1, Math.ceil(dist / bs));
        for (let j = 1; j < steps; j++) {
          const t = j / steps;
          paintDot(prev.x + (cur.x - prev.x) * t, prev.y + (cur.y - prev.y) * t);
        }
      }
    }
  }
}

// 从多屏截图采样一块区域，绘制到目标矩形（用于马赛克/放大镜/导出/OCR）。
// 坐标系约定：src 侧（sx, sy）与 screens[] 一律是 **root-local 物理像素**；
// dst 侧（dx, dy, dw, dh）是目标 canvas 的坐标。两侧各自独立，不混用。
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
    // 每个图形用自己的 strokeWidth（创建时快照），改工具栏粗细不影响已画的
    if (s.tool === "mosaic") drawMosaic(ctx, s);
    else drawShape(ctx, s);
  }

  // 当前绘制中的图形
  if (curShape) {
    if (curShape.tool === "mosaic") drawMosaic(ctx, curShape);
    else drawShape(ctx, curShape);
  }

  // 选区边框（绿色 + 8 锚点）：用 selRect（= 拖拽中的动态选区 或 已定选区），
  // 与微信截图一致 —— 拉框过程中绿色框实时跟随，选区完成/移动/缩放时也显示。
  if (selRect && selRect.w > 0 && selRect.h > 0) {
    drawStyleBox(ctx, selRect);
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
let magWarnedZero = false;

function sampleMagnifier(cx: number, cy: number): Uint8ClampedArray | null {
  const half = Math.floor(MAG_GRID / 2);
  const sx = Math.round(cx) - half;
  const sy = Math.round(cy) - half;
  magTempCtx.clearRect(0, 0, MAG_GRID, MAG_GRID);
  blitRegion(magTempCtx, sx, sy, MAG_GRID, MAG_GRID, 0, 0, MAG_GRID, MAG_GRID);
  let data: Uint8ClampedArray;
  try {
    data = magTempCtx.getImageData(0, 0, MAG_GRID, MAG_GRID).data;
  } catch {
    return null;
  }
  // 诊断：如果所有像素 alpha=0（采样失败/越界/跨屏），第一次打印一次
  if (!magWarnedZero && data.every((v, i) => i % 4 !== 3 || v === 0)) {
    magWarnedZero = true;
    const zero = data.every((v) => v === 0);
    console.warn(
      "[screenshot] magnifier all-zero sample at", sx, sy,
      "allZero=" + zero,
      "screensN=" + screens.length,
      "screensReady=" + screens.map((s) => s.img.naturalWidth + "x" + s.img.naturalHeight).join(","),
    );
  }
  return data;
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

/// p 是否落在当前选区内（用于「选区外禁止光标 / 选区内拖拽移动选区」）
function pointInSelection(p: Pt): boolean {
  return (
    !!selection &&
    p.x >= selection.x && p.x <= selection.x + selection.w &&
    p.y >= selection.y && p.y <= selection.y + selection.h
  );
}

/// 把所有图形整体平移 (dx, dy)（移动选区时，标注内容跟随选区一起走，保持相对位置）
function translateShapes(dx: number, dy: number) {
  for (const s of shapes) {
    s.start.x += dx; s.start.y += dy;
    s.end.x += dx; s.end.y += dy;
    if (s.points) {
      for (const q of s.points) { q.x += dx; q.y += dy; }
    }
  }
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
      // pen 和 mosaic 都是笔刷式：在 mousedown 时先入一个点，后续 mousemove 累加
      points: tool === "pen" || tool === "mosaic" ? [{ ...cp }] : undefined,
    };
    render();
    return;
  }

  // 4. 无工具
  //    微信式：已有选区时不再重新拉框（点工具栏工具也不会重置选区）。
  //    点在选区内 → 整体移动选区（拖动选区）；点在选区外 → 仅取消图形选中。
  //    想重新选 → 点工具栏「重新截图」按钮（清空 selection）或 Esc 退出。
  if (selection) {
    if (pointInSelection(p)) {
      // 先取消图形选中，避免「移选区」和「移图形」混淆
      selectedIndex = null;
      dragMode = "move-selection";
      moveSelectionStart = { ...p };
      moveSelectionOrig = { ...selection };
    } else if (selectedIndex != null) {
      selectedIndex = null;
    }
    render();
    return;
  }
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

  if (dragMode === "move-selection" && moveSelectionStart && moveSelectionOrig) {
    // 拖动整体移动选区：选区四角限制在屏幕内，标注内容跟随选区平移（保持相对位置）
    const w = moveSelectionOrig.w, h = moveSelectionOrig.h;
    const nx = Math.min(Math.max(moveSelectionOrig.x + (p.x - moveSelectionStart.x), 0), Math.max(0, totalW - w));
    const ny = Math.min(Math.max(moveSelectionOrig.y + (p.y - moveSelectionStart.y), 0), Math.max(0, totalH - h));
    const appDx = nx - moveSelectionOrig.x;
    const appDy = ny - moveSelectionOrig.y;
    selection = { x: nx, y: ny, w, h };
    translateShapes(appDx, appDy);
    render();
    return;
  }

  // 绘制中（终点/笔迹点 clamp 到选区 —— 原版 drag.rs 行为）
  if (curShape) {
    const cp = clampToSelection(p);
    curShape.end = cp;
    if ((curShape.tool === "pen" || curShape.tool === "mosaic") && curShape.points) {
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
  // 命中图形 → move；有工具 → crosshair（画/拖）；
  // 无工具且有选区 → 选区外 not-allowed（禁止符号），选区内 move（可拖动选区）；
  // 无工具且无选区 → crosshair（确实要选）。
  const cursor =
    hit != null ? "move" :
    tool ? "crosshair" :
    !selection ? "crosshair" :
    pointInSelection(p) ? "move" : "not-allowed";
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  if (hit !== hoverIndex) {
    hoverIndex = hit;
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

  if (dragMode === "move-selection") {
    dragMode = "none";
    moveSelectionStart = null;
    moveSelectionOrig = null;
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
    if (s.tool === "mosaic") drawMosaic(oc, s);
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

  // 换图期间隐藏：避免复用窗口时闪旧画面 / 半加载画面
  document.body.classList.remove("ready");

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
  // 重置工具选择：否则上次用过的画笔会跨会话保留，下次 Alt+S 进入直接是
  // 画笔态（点哪画哪，无法拉选区）。每次新截图都从「无工具 / 选区模式」开始。
  tool = null;
  for (const b of toolBtns.values()) b.classList.toggle("active", false);
  hoverIndex = null;
  moveStart = null;
  moveOrigShape = null;
  resizeOrig = null;
  resizeHandle = -1;
  moveSelectionStart = null;
  moveSelectionOrig = null;
  textInput.classList.remove("editing");
  ocrPanel.style.display = "none";
  screens = [];

  totalW = data.total_width;
  totalH = data.total_height;
  minX = data.min_x;
  minY = data.min_y;

  canvas.width = totalW;
  canvas.height = totalH;

  // 拼接多屏截图
  // 注意：screens 一律存 **root-local 物理坐标**（= 后端 global - minX/minY），
  // 与 physPos()/shape 坐标同一套系；blitRegion 内部比较时不再混用坐标系。
  // 之前存的是后端 global，而传入 blitRegion 的 sx/sy 是 root-local（来自 physPos /
  // shapeBBox），多屏（minX≠0）时比较结果完全错位 → 放大镜采样到别的屏、
  // 马赛克糊的是错误区域。
  const pending: Promise<unknown>[] = [];
  for (const s of data.screens) {
    const img = document.createElement("img");
    img.src = s.data_url;
    const rx = s.x - minX; // root-local 物理
    const ry = s.y - minY;
    img.style.left = `${rx / physScale()}px`;
    img.style.top = `${ry / physScale()}px`;
    img.style.width = `${s.width / physScale()}px`;
    img.style.height = `${s.height / physScale()}px`;
    root.insertBefore(img, canvas);
    screens.push({ img, x: rx, y: ry, w: s.width, h: s.height });
    // 等解码完成再显示，避免逐张出现的闪烁（decode 失败时退化为 onload/onerror）
    pending.push(
      typeof img.decode === "function"
        ? img.decode().catch(() => undefined)
        : new Promise((r) => {
            img.onload = img.onerror = () => r(undefined);
          }),
    );
  }
  await Promise.all(pending);

  console.info(
    "[screenshot] bounds", data.min_x, data.min_y, data.total_width, data.total_height,
    "scale", physScale().toFixed(2), "screens", data.screens.length,
  );
  // 一次性诊断：完整 viewport + 每屏 img 状态，在跨屏/混合 DPI 异常时可一眼定位。
  // 数据来源完全靠前端能拿到的字段（getBoundingClientRect + data.monitor_info），
  // 正常运行时零开销。
  const rr = root.getBoundingClientRect();
  console.info(
    "[screenshot] viewport:",
    JSON.stringify({
      totalW, totalH, minX: data.min_x, minY: data.min_y,
      rootW: +rr.width.toFixed(1), rootH: +rr.height.toFixed(1),
      rootLeft: +rr.left.toFixed(1), rootTop: +rr.top.toFixed(1),
      dpr: window.devicePixelRatio,
      physScale: +physScale().toFixed(4),
      canvasAttr: `${canvas.width}x${canvas.height}`,
      canvasCss: `${+canvas.getBoundingClientRect().width.toFixed(1)}x${+canvas.getBoundingClientRect().height.toFixed(1)}`,
      monitors: data.monitor_info,
    }),
  );

  render();

  // 首帧就绪：CSS/布局完成后再显示，避免初始化期间 FOUC（元素挤在左上角）
  if (!document.body.classList.contains("ready")) {
    document.body.classList.add("ready");
  }
}

async function refreshConfig() {
  // 读配置（每次复用/刷新都要重新读，这样「截图放大镜」等设置在下一次进入截图时立即生效）
  try {
    const cfg = await getConfig();
    magnifierActive = cfg.magnifier_enabled;
    setLang(cfg.language);
    if (cfg.hotkeys?.copy_color) copyColorHotkey = cfg.hotkeys.copy_color;
    applyTheme(cfg.theme);
  } catch {
    // 读配置失败则保持默认
  }
  applyI18n(document);
}

// 截图窗口 UI 主题：与主窗口一致，跟随 config.theme（dark / light / system），
// 由 screenshot.html 里 :root[data-theme] 变量驱动工具栏/弹窗/帮助框/OCR 面板配色。
function applyTheme(theme: "dark" | "light" | "system") {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

async function main() {
  await refreshConfig();

  // 后端复用窗口时 main() 不会重跑，但会 emit screenshot-refresh 触发 loadScreenshot；
  // 此处重读配置再重载，否则复用窗口下「截图放大镜」等设置不生效。
  await listen("screenshot-refresh", async () => {
    await refreshConfig();
    await loadScreenshot();
  });

  // 后端隐藏窗口前 emit：清掉画面，避免下次 show 时闪旧截图
  await listen("screenshot-clear", () => {
    root.querySelectorAll("img").forEach((el) => el.remove());
    screens = [];
    shapes = [];
    selection = null;
    curShape = null;
    dragStart = dragCur = null;
    dragMode = "none";
    selectedIndex = null;
    ocrPanel.style.display = "none";
    textInput.classList.remove("editing");
    moveSelectionStart = null;
    moveSelectionOrig = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    document.body.classList.remove("ready");
  });

  await loadScreenshot();
}

void main();

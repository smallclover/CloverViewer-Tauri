import {
  closeScreenshot,
  copyText,
  discardScrollCapture,
  finishScrollCapture as finishScrollCaptureCmd,
  finishScreenshot,
  getConfig,
  getScreenshotData,
  ocrImage,
  pickWindowAt,
  screenshotUiReady,
  scrollCaptureProgress,
  scrollCaptureRunning,
  startScrollCapture,
  stopScrollCapture as stopScrollCaptureCmd,
  takeScrollStartMode,
  type ScrollCaptureDone,
  type ScrollCaptureProgress,
} from "./api";
import { applyI18n, setLang, t } from "./i18n";
import { listen } from "@tauri-apps/api/event";
import { ShapeHistory } from "./screenshot/history";
import { drawAnnotation } from "./screenshot/annotation-renderer";
import { forEachMosaicStamp } from "./screenshot/mosaic";
import { overlaps, placeScrollOverlay, placeSelectionOverlay } from "./screenshot/overlay-layout";
import { resizeShape, type ResizeOrigin } from "./screenshot/resize";
import { blitScreenRegion, drawScreenBase } from "./screenshot/screen-compositor";
import {
  cloneShape,
  isShapeHit,
  normRect,
  shapeBBox,
  shapeHandles,
  translateShape,
  type Pt,
  type Rect,
  type Shape,
  type Tool,
} from "./screenshot/geometry";

// ============================================================
// 截图标注器 —— 移植自 CloverViewer feature/screenshot 的 Canvas 2D 重写
//
// 坐标约定：所有图形数据统一用「物理像素」（与 xcap 返回一致）。
// 前端仅做交互绘制；导出时用同一套 draw 逻辑在离屏 Canvas 上合成，
// 再交给 Rust 落盘/写剪贴板。
// ============================================================

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
  "#cc0000",
  "#ff0000",
  "#ff6600",
  "#ffcc00",
  "#00cc00",
  "#0099ff",
  "#0000ff",
  "#9900ff",
  "#000000",
  "#ffffff",
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

// 窗口吸附：悬停时绿框自动框住光标下方的窗口（root-local 物理坐标）
let hoverWin: Rect | null = null;
let lastWinQuery = 0;
let winQuerySeq = 0;
let lastQueryPos: Pt | null = null;
// 区分「单击选中绿框的窗口/显示器」 vs 「按住拖拽画自定义选区」：
// mousedown 先进入 pending-win 挂起；拖动>阈值转自定义选区，松手没动则选中该窗口/显示器。
let pendingWinSelect: Rect | null = null;

let tool: Tool | null = null;
let color = DEFAULT_COLOR;
let strokeWidth = DEFAULT_STROKE;
const mosaicWidth = DEFAULT_MOSAIC;

let shapes: Shape[] = [];
const history = new ShapeHistory();

let curShape: Shape | null = null; // 正在绘制
let selectedIndex: number | null = null;
let hoverIndex: number | null = null;

type DragMode = "none" | "select" | "move" | "resize" | "move-selection" | "pending-win";
let dragMode: DragMode = "none";
let resizeHandle = -1;
let moveStart: Pt | null = null;
let moveOrigShape: Shape | null = null;
let moveHistorySnapshot: Shape[] | null = null;
let resizeOrig: ResizeOrigin | null = null;
let resizeHistorySnapshot: Shape[] | null = null;
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
function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing screenshot element: ${id}`);
  return element as T;
}
function requiredContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  return context;
}
const root = requiredElement("screenshot-root");
const canvas = requiredElement<HTMLCanvasElement>("overlay-canvas");
const ctx = requiredContext(canvas);
const uiLayer = requiredElement("ui-layer");

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
  // OCR / 文字识别：扫描框（四角）+ 三行文字（lucide scan-text 风格），
  // 一眼即“扫描识别文字”，比原先的“方块+几条线”更贴切。
  ocr:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/>' +
    '<path d="M17 3h2a2 2 0 0 1 2 2v2"/>' +
    '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/>' +
    '<path d="M7 21H5a2 2 0 0 1-2-2v-2"/>' +
    '<path d="M7 8h8"/>' +
    '<path d="M7 12h10"/>' +
    '<path d="M7 16h6"/>',
  // 重新截图：刷新环箭头（lucide rotate-cw 风格），点它清空选区回到拉框
  reselect: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  // 滚动截图：一页纸 + 向下的续页箭头（“往下一直截”）
  scroll:
    '<rect x="6" y="3" width="12" height="16" rx="1.6"/>' +
    '<path d="M12 7v7"/>' +
    '<path d="M9.4 11.4 12 14l2.6-2.6"/>',
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

// OCR：文字识别。非绘制工具——点击即识别，不进入工具选中态；放在「文本(T)」工具后面，
// 与文字相关。不参与 toolBtns 选中高亮。
const ocrBtn = makeBtn("ocr", "shot.ocr");
ocrBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void runOcr();
});
toolbar.appendChild(ocrBtn);

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
toolbar.appendChild(cancelBtn);
toolbar.appendChild(copyBtn);
toolbar.appendChild(saveBtn);

uiLayer.appendChild(toolbar);

// ---------- 颜色面板 ----------
const colorPopup = document.createElement("div");
colorPopup.className = "popup ui-interactive";
// 原生取色条（<input type="color">）：选调色板之外的任意颜色用。模块级引用以便同步它的显示值。
let nativeColorInput: HTMLInputElement | null = null;
{
  const pal = document.createElement("div");
  pal.className = "palette";
  const native = document.createElement("input");
  native.type = "color";
  native.className = "native";
  native.value = color;
  native.addEventListener("input", () => {
    color = native.value;
    colorSwatch.style.background = color;
  });
  nativeColorInput = native;
  for (const c of PALETTE) {
    const cell = document.createElement("div");
    cell.className = `cell${c === color ? " sel" : ""}`;
    cell.style.background = c;
    cell.addEventListener("click", () => {
      color = c;
      // 同步原生取色条的显示值，避免它停在旧颜色上"不变"
      if (nativeColorInput) nativeColorInput.value = c;
      colorSwatch.style.background = c;
      syncColorPopup();
      closePopups();
    });
    pal.appendChild(cell);
  }
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

// ---------- 帮助框（快捷键提示） ----------
// 逐项渲染成「键帽 + 说明」，而不是一整段多行文本：键帽等宽、说明左对齐，
// 换语言时长文案不会把整行挤歪。每一项都必须与下面 keydown 里真实生效的
// 交互一一对应（改快捷键时同步改这张表，别让提示和实际脱节）。
const helpBox = document.createElement("div");
helpBox.id = "help-box";

const HELP_ITEMS: { kbdI18n?: string; kbd?: string; labelI18n: string }[] = [
  // 鼠标：与 onMouseDown / onMouseMove 的窗口吸附一致
  { kbdI18n: "shot.hint.dragKey", labelI18n: "shot.hint.drag" },
  { kbdI18n: "shot.hint.clickKey", labelI18n: "shot.hint.click" },
  // 键盘：与 window keydown 一致
  { kbd: "Enter", labelI18n: "shot.hint.enter" },
  { kbd: "Esc", labelI18n: "shot.hint.esc" },
  { kbd: "Delete", labelI18n: "shot.hint.delete" },
  { kbd: "Ctrl+Z", labelI18n: "shot.hint.undo" },
  { kbd: "Ctrl+Y", labelI18n: "shot.hint.redo" },
];

function makeHintRow(kbdText: string, labelI18n: string, kbdI18n?: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "hint";
  const kbd = document.createElement("kbd");
  if (kbdI18n) kbd.dataset.i18n = kbdI18n;
  kbd.textContent = kbdI18n ? t(kbdI18n) : kbdText;
  const label = document.createElement("span");
  label.dataset.i18n = labelI18n;
  label.textContent = t(labelI18n);
  row.append(kbd, label);
  return row;
}

for (const it of HELP_ITEMS) {
  helpBox.appendChild(makeHintRow(it.kbd ?? "", it.labelI18n, it.kbdI18n));
}
// 取色热键可由用户在设置里改（config.hotkeys.copy_color）→ 键帽文案取实际配置值，
// 放大镜关掉时该键无效，整行隐藏（避免提示一个按了没反应的键）。
const helpColorRow = makeHintRow("Alt+C", "shot.hint.copyColor");
const helpColorKbd = helpColorRow.querySelector("kbd") as HTMLElement;
helpBox.appendChild(helpColorRow);
uiLayer.appendChild(helpBox);

function updateHelpBox() {
  helpColorKbd.textContent = copyColorHotkey;
  helpColorRow.style.display = magnifierActive ? "" : "none";
}

// 与 screenshot.html 里 #help-box 的边距保持一致
const HELP_MARGIN = 12;
/** 截图窗打开瞬间的鼠标位置。初始时还没有 mousemove，也要把提示放在当前屏。 */
let initialCursorPos: Pt | null = null;

/** 将普通截图提示限制在鼠标所在显示器；多屏时不能按整个虚拟桌面的左下角摆放。 */
function positionHelpBox() {
  if (toolbar.style.display === "none") {
    // 未框选时不展示整块快捷键说明。截图覆盖窗刚由 Alt+S 唤起时只保留
    // 干净的取景画面；用户完成框选后，随选区工具栏一起再显示操作提示。
    helpBox.style.display = "none";
    helpBox.style.transform = "";
    return;
  }
  helpBox.style.display = "grid";
  const hbW = helpBox.offsetWidth;
  const hbH = helpBox.offsetHeight;
  if (!hbW || !hbH) return;
  const anchor = lastMousePos ?? initialCursorPos;
  const monitor = monitorBoxCss(anchor ? { x: anchor.x, y: anchor.y, w: 1, h: 1 } : null);
  const left = monitor.x + HELP_MARGIN;
  const top = monitor.y + monitor.h - hbH - HELP_MARGIN;
  helpBox.style.left = `${Math.round(left)}px`;
  helpBox.style.top = `${Math.round(top)}px`;
  helpBox.style.bottom = "auto";

  // 工具栏被挤到本屏左下角时，把提示框抬到工具栏上方。
  const rootRect = root.getBoundingClientRect();
  const tb = toolbar.getBoundingClientRect();
  const toolbarBox = {
    left: tb.left - rootRect.left,
    right: tb.right - rootRect.left,
    top: tb.top - rootRect.top,
    bottom: tb.bottom - rootRect.top,
  };
  const hit =
    toolbarBox.left < left + hbW &&
    toolbarBox.right > left &&
    toolbarBox.top < top + hbH &&
    toolbarBox.bottom > top;
  helpBox.style.transform = hit
    ? `translateY(-${Math.ceil(top + hbH - toolbarBox.top + 8)}px)`
    : "";
}

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
  const pw = 320,
    ph = 220; // 逻辑像素
  const point = placeSelectionOverlay(toCssBox(selection), rootBoxCss(), { w: pw, h: ph }, "start");
  ocrPanel.style.left = `${point.x}px`;
  ocrPanel.style.top = `${point.y}px`;
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
function hitTestShapes(p: Pt): number | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (isShapeHit(shapes[i], p, 8 * physScale())) return i;
  }
  return null;
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
  const tc = requiredContext(tmp);
  const paintDot = (px: number, py: number) => {
    const dx = px - bs / 2;
    const dy = py - bs / 2;
    blitScreenRegion(tc, screenSources(), dx, dy, bs, bs, 0, 0, 1, 1);
    const d = tc.getImageData(0, 0, 1, 1).data;
    c.fillStyle = `rgba(${d[0]},${d[1]},${d[2]},${(d[3] / 255).toFixed(3)})`;
    c.fillRect(dx, dy, bs, bs);
  };
  forEachMosaicStamp(points, bs, (point) => paintDot(point.x, point.y));
}

// 从多屏截图采样一块区域，绘制到目标矩形（用于马赛克/放大镜/导出/OCR）。
// 坐标系约定：src 侧（sx, sy）与 screens[] 一律是 **root-local 物理像素**；
// dst 侧（dx, dy, dw, dh）是目标 canvas 的坐标。两侧各自独立，不混用。
function screenSources() {
  return screens.map(({ img, x, y, w, h }) => ({ image: img, x, y, w, h }));
}

function render() {
  // 滚动截图进行中/已完成：只画「压暗 + 选区挖空 + 外框」，不画底图/标注/工具栏。
  // 选区挖空是硬要求——后端按屏幕像素捕获，覆盖窗在选区里必须完全透明。
  if (scrollActive()) {
    renderScrollOverlay();
    positionScrollUi();
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 拼接底图
  drawScreenBase(ctx, screenSources());

  // 遮罩：有选区/拖动时，选区外变暗（选区用底图重新覆盖，而不是 clearRect 挖洞——
  // 挖洞会清掉画布底图、透出活桌面，跨屏时恰恰在交界处露馅）
  const selRect =
    dragMode === "select" && dragStart && dragCur ? normRect(dragStart, dragCur) : selection;
  if (selRect && selRect.w > 0 && selRect.h > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(selRect.x, selRect.y, selRect.w, selRect.h);
    ctx.clip();
    drawScreenBase(ctx, screenSources());
    ctx.restore();
  }

  // 图形
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    // 每个图形用自己的 strokeWidth（创建时快照），改工具栏粗细不影响已画的
    if (s.tool === "mosaic") drawMosaic(ctx, s);
    else drawAnnotation(ctx, s, physScale());
  }

  // 当前绘制中的图形
  if (curShape) {
    if (curShape.tool === "mosaic") drawMosaic(ctx, curShape);
    else drawAnnotation(ctx, curShape, physScale());
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
      ctx.fillRect(
        h.x - 5 * physScale(),
        h.y - 5 * physScale(),
        10 * physScale(),
        10 * physScale(),
      );
      ctx.strokeRect(
        h.x - 5 * physScale(),
        h.y - 5 * physScale(),
        10 * physScale(),
        10 * physScale(),
      );
    }
  }

  // 工具栏定位
  if (selection) {
    toolbar.style.display = "flex";
    const point = placeSelectionOverlay(
      toCssBox(selection),
      rootBoxCss(),
      { w: toolbar.offsetWidth || 360, h: toolbar.offsetHeight || 44 },
      "end",
    );
    toolbar.style.left = `${point.x}px`;
    toolbar.style.top = `${point.y}px`;
  } else {
    toolbar.style.display = "none";
  }

  // 提示框避让：工具栏落到左下角时把它抬到工具栏上方，别互相压住
  positionHelpBox();

  // 滚动截图「待开始」态：选区一确定就把开始面板摆出来（拖拽过程中也跟着刷新）
  if (scrollPhase === "armed") syncScrollUi();

  // OCR 面板跟随选区 —— 选区移动/重选时同步刷新位置（之前只 showOcrPanel 调一次）。
  if (selection && ocrPanel.style.display !== "none") {
    positionOcrPanel();
  }

  // 放大镜（跟随光标，悬停于 UI 上时不显示）
  if (magnifierActive && lastMousePos && !overUI) {
    drawMagnifier(ctx, lastMousePos.x, lastMousePos.y);
  }

  // 窗口吸附：绿框自动框住光标下方窗口；空白处则框住光标所在的那块显示器
  // （pending-win 时也保持显示，直到开始拖动或单击选中）
  if (hoverWin && !selection && !tool && (dragMode === "none" || dragMode === "pending-win")) {
    drawWindowBox(ctx, hoverWin);
  }
}

/// 统一的绿色框样式：粗边向内缩（不向相邻屏凸出）+ 8 个内缩手柄 + 左上角 `WxH` 尺寸标注。
/// 跟随鼠标的吸附框和点击/拖拽选中的选区框都用它，保证视觉一致。
function drawGreenBox(c: CanvasRenderingContext2D, r: Rect) {
  const asz = 8 * physScale();
  const lw = 3 * physScale();
  // 窗口吸附拿到的是系统的外框边界；粗线即使完全画在框内，视觉上也会
  // 压住可见窗口边沿，让人觉得选区比窗口大。再内收 1 个视觉像素，边界更贴合。
  const visualInset = physScale();
  c.strokeStyle = "#00ff00";
  c.lineWidth = lw;
  c.strokeRect(
    r.x + lw / 2 + visualInset,
    r.y + lw / 2 + visualInset,
    Math.max(1, r.w - lw - visualInset * 2),
    Math.max(1, r.h - lw - visualInset * 2),
  );
  if (r.w > asz * 3 && r.h > asz * 3) {
    const cx = r.x + r.w / 2,
      cy = r.y + r.h / 2;
    c.fillStyle = "#00ff00";
    for (const [px, py] of [
      [r.x + asz / 2, r.y + asz / 2],
      [r.x + r.w - asz / 2, r.y + asz / 2],
      [r.x + r.w - asz / 2, r.y + r.h - asz / 2],
      [r.x + asz / 2, r.y + r.h - asz / 2],
      [cx, r.y + asz / 2],
      [cx, r.y + r.h - asz / 2],
      [r.x + asz / 2, cy],
      [r.x + r.w - asz / 2, cy],
    ]) {
      c.fillRect(px - asz / 2, py - asz / 2, asz, asz);
    }
  }
  // 左上角尺寸标注（宽×高），带深色底衬保证可读
  const label = `${Math.round(r.w)}x${Math.round(r.h)}`;
  const fs = 13 * physScale();
  c.font = `600 ${fs}px monospace`;
  c.textBaseline = "top";
  const tw = c.measureText(label).width;
  c.fillStyle = "rgba(0,0,0,0.55)";
  c.fillRect(r.x + 4, r.y + 4, tw + 8 * physScale(), fs + 6 * physScale());
  c.fillStyle = "#00ff00";
  c.fillText(label, r.x + 8, r.y + 7);
}

/// 窗口吸附悬停框：套住光标下方窗口（或整块显示器）
function drawWindowBox(c: CanvasRenderingContext2D, r: Rect) {
  drawGreenBox(c, r);
}

function drawStyleBox(c: CanvasRenderingContext2D, r: Rect) {
  drawGreenBox(c, r);
}

// ============================================================
// 放大镜
// ============================================================
const magTemp = document.createElement("canvas");
magTemp.width = MAG_GRID;
magTemp.height = MAG_GRID;
const magTempCtx = requiredContext(magTemp);
let magWarnedZero = false;

function sampleMagnifier(cx: number, cy: number): Uint8ClampedArray | null {
  const half = Math.floor(MAG_GRID / 2);
  const sx = Math.round(cx) - half;
  const sy = Math.round(cy) - half;
  magTempCtx.clearRect(0, 0, MAG_GRID, MAG_GRID);
  blitScreenRegion(
    magTempCtx,
    screenSources(),
    sx,
    sy,
    MAG_GRID,
    MAG_GRID,
    0,
    0,
    MAG_GRID,
    MAG_GRID,
  );
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
      "[screenshot] magnifier all-zero sample at",
      sx,
      sy,
      `allZero=${zero}`,
      `screensN=${screens.length}`,
      `screensReady=${screens.map((s) => `${s.img.naturalWidth}x${s.img.naturalHeight}`).join(",")}`,
    );
  }
  return data;
}

function centerColorHex(data: Uint8ClampedArray): string {
  const half = Math.floor(MAG_GRID / 2);
  const i = (half * MAG_GRID + half) * 4;
  const r = data[i],
    g = data[i + 1],
    b = data[i + 2];
  return `#${[r, g, b]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function drawMagnifier(c: CanvasRenderingContext2D, px: number, py: number) {
  const data = sampleMagnifier(px, py);
  if (!data) return;

  const half = Math.floor(MAG_GRID / 2);
  const gridLog = MAG_GRID * MAG_PIXEL; // 150 逻辑像素
  const r = root.getBoundingClientRect();
  const kx = r.width / totalW,
    ky = r.height / totalH;

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
  c.moveTo(ps(cardX), mgCy);
  c.lineTo(ps(cardX) + ps(gridLog), mgCy);
  c.moveTo(mgCx, ps(cardY));
  c.lineTo(mgCx, ps(cardY) + ps(gridLog));
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
  c.fillText(
    `(${Math.round(px)}, ${Math.round(py)})`,
    ps(cardX) + pad,
    infoY + rowH * 0.5 + 2 * physScale(),
  );

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
  c.fillText(
    t("shot.copyColorHint", { key: copyColorHotkey }),
    ps(cardX) + pad,
    infoY + rowH * 2.5,
  );

  c.restore();
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
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
    p.x >= selection.x &&
    p.x <= selection.x + selection.w &&
    p.y >= selection.y &&
    p.y <= selection.y + selection.h
  );
}

/// 把所有图形整体平移 (dx, dy)（移动选区时，标注内容跟随选区一起走，保持相对位置）
function translateShapes(dx: number, dy: number) {
  for (const s of shapes) {
    translateShape(s, dx, dy);
  }
}

// ============================================================
// 历史
// ============================================================
function pushHistory() {
  history.checkpoint(shapes);
}

function undo() {
  const previous = history.undo(shapes);
  if (!previous) return;
  shapes = previous;
  selectedIndex = null;
  render();
}

function redo() {
  const next = history.redo(shapes);
  if (!next) return;
  shapes = next;
  selectedIndex = null;
  render();
}

// ============================================================
// 鼠标交互
// ============================================================
function onMouseDown(e: MouseEvent) {
  // 滚动捕获中/完成后不允许再拉选区：区域必须锁定，否则选区一动拼接基准就废了
  if (scrollActive()) return;
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
    resizeHistorySnapshot = shapes.map(cloneShape);
    return;
  }

  // 2. 命中图形 → 选中 + 移动
  const hit = hitTestShapes(p);
  if (hit != null) {
    selectedIndex = hit;
    dragMode = "move";
    moveStart = p;
    moveOrigShape = cloneShape(shapes[hit]);
    moveHistorySnapshot = shapes.map(cloneShape);
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
  // 微信式：绿框已套住光标下方窗口/显示器——先挂起，区分「单击选中」vs「按住拖拽自定义选区」。
  // 若随后拖动（onMouseMove 超过阈值）→ 转自定义选区；若松手没动（onMouseUp）→ 选中该窗口/显示器。
  if (hoverWin) {
    pendingWinSelect = { ...hoverWin };
    dragMode = "pending-win";
    dragStart = { ...p };
    dragCur = { ...p };
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
  // 长截图捕获/结果态的区域已经锁定，鼠标不应再进入普通截图的悬停状态机。
  // 否则预览 HUD 上的 mousemove 会冒泡到 window，重新把 canvas 写成 crosshair。
  if (scrollActive()) {
    if (canvas.style.cursor !== "default") canvas.style.cursor = "default";
    return;
  }
  const p = physPos(e);

  // 放大镜跟随 + 悬停 UI 检测
  lastMousePos = p;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // 所有真正接收鼠标事件的浮层统一从画布状态机隔离。此前只列出 toolbar/popup，
  // 新增的滚动开始面板/HUD/提示条仍会冒泡到这里，继承到 crosshair。
  overUI = !!el && !!(el as HTMLElement).closest?.(".ui-interactive, #text-input");
  if (overUI) {
    if (canvas.style.cursor !== "default") canvas.style.cursor = "default";
    if (hoverWin && dragMode !== "pending-win") {
      hoverWin = null;
      render();
    }
    return;
  }

  // 窗口吸附：仅在"未拉框/未选/未用工具"时，查光标下方窗口，让绿框自动框住它。
  // 节流 ~40ms + 仅在光标移动超过 2px 时查，避免高频 IPC；用序号保证只采纳最新结果。
  if (!overUI && dragMode === "none" && !selection && !tool) {
    const now = performance.now();
    const moved = !lastQueryPos || Math.hypot(p.x - lastQueryPos.x, p.y - lastQueryPos.y) > 2;
    if (now - lastWinQuery > 40 && moved) {
      lastWinQuery = now;
      lastQueryPos = { ...p };
      const seq = ++winQuerySeq;
      const gx = Math.round(p.x + minX),
        gy = Math.round(p.y + minY);
      void pickWindowAt(gx, gy).then((r) => {
        if (seq !== winQuerySeq) return; // 过期结果，丢弃
        if (!r) {
          // 光标不在任何窗口上（显示器空白处）→ 圈住光标所在的那块显示器（整个屏幕一圈）
          const mon = screens.find(
            (s) => p.x >= s.x && p.x < s.x + s.w && p.y >= s.y && p.y < s.y + s.h,
          );
          hoverWin = mon ? { x: mon.x, y: mon.y, w: mon.w, h: mon.h } : null;
        } else {
          hoverWin = { x: r.x - minX, y: r.y - minY, w: r.width, h: r.height };
        }
        render();
      });
    }
  } else if (hoverWin && dragMode !== "pending-win") {
    hoverWin = null;
  }

  // pending-win：按下后若拖动超过阈值，说明想画自定义选区 → 转成 select 拖拽
  if (dragMode === "pending-win") {
    dragCur = p;
    if (dragStart && Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > 3) {
      pendingWinSelect = null;
      hoverWin = null;
      dragMode = "select";
    }
    render();
    return;
  }

  if (dragMode === "select") {
    dragCur = p;
    render();
    return;
  }
  if (dragMode === "move" && moveStart && moveOrigShape && selectedIndex != null) {
    // 移动也 clamp：算出移动后的 bbox，把 delta 收敛到选区内（原版 move_shape 行为）
    const dx = p.x - moveStart.x,
      dy = p.y - moveStart.y;
    const orig = moveOrigShape;
    let ddx = dx,
      ddy = dy;
    if (selection) {
      const selR = selection;
      const minX0 = Math.min(orig.start.x, orig.end.x),
        maxX0 = Math.max(orig.start.x, orig.end.x);
      const minY0 = Math.min(orig.start.y, orig.end.y),
        maxY0 = Math.max(orig.start.y, orig.end.y);
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
    const resized = resizeShape(
      shapes[selectedIndex],
      resizeOrig,
      resizeHandle,
      clampToSelection(p),
      MIN_SHAPE_SIZE,
    );
    if (resized) shapes[selectedIndex] = resized;
    render();
    return;
  }

  if (dragMode === "move-selection" && moveSelectionStart && moveSelectionOrig) {
    // 拖动整体移动选区：选区四角限制在屏幕内，标注内容跟随选区平移（保持相对位置）
    const w = moveSelectionOrig.w,
      h = moveSelectionOrig.h;
    const nx = Math.min(
      Math.max(moveSelectionOrig.x + (p.x - moveSelectionStart.x), 0),
      Math.max(0, totalW - w),
    );
    const ny = Math.min(
      Math.max(moveSelectionOrig.y + (p.y - moveSelectionStart.y), 0),
      Math.max(0, totalH - h),
    );
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
    hit != null
      ? "move"
      : tool
        ? "crosshair"
        : !selection
          ? "crosshair"
          : pointInSelection(p)
            ? "move"
            : "not-allowed";
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

  // pending-win：松手时若没拖动（是单击）→ 选中绿框预览的窗口/显示器
  if (dragMode === "pending-win") {
    if (pendingWinSelect) {
      selection = { ...pendingWinSelect };
    }
    pendingWinSelect = null;
    hoverWin = null;
    dragMode = "none";
    dragStart = dragCur = null;
    render();
    // 滚动截图在框选后停留在 armed 态，开始面板会以该选区为锚点显示；
    // 用户确认模式/「从顶部开始」选项后再点击开始，不能在松开鼠标时抢跑。
    return;
  }

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
    // 同上：矩形选区完成后显示开始面板，不自动开跑。
    return;
  }

  if (dragMode === "move") {
    if (moveOrigShape) {
      // 有实际位移才记历史
      const s = selectedIndex == null ? null : shapes[selectedIndex];
      if (s && (s.start.x !== moveOrigShape.start.x || s.start.y !== moveOrigShape.start.y)) {
        if (moveHistorySnapshot) history.checkpoint(moveHistorySnapshot);
      }
    }
    dragMode = "none";
    moveStart = null;
    moveOrigShape = null;
    moveHistorySnapshot = null;
    render();
    return;
  }

  if (dragMode === "resize") {
    const s = selectedIndex == null ? null : shapes[selectedIndex];
    if (
      s &&
      resizeOrig &&
      resizeHistorySnapshot &&
      (s.start.x !== resizeOrig.start.x ||
        s.start.y !== resizeOrig.start.y ||
        s.end.x !== resizeOrig.end.x ||
        s.end.y !== resizeOrig.end.y ||
        s.strokeWidth !== resizeOrig.strokeWidth)
    ) {
      history.checkpoint(resizeHistorySnapshot);
    }
    dragMode = "none";
    resizeHandle = -1;
    resizeOrig = null;
    resizeHistorySnapshot = null;
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

// ---------- 文本输入 ----------
function showTextInput(p: Pt) {
  const r = root.getBoundingClientRect();
  const kx = r.width / totalW,
    ky = r.height / totalH;
  const lx = p.x * kx,
    ly = p.y * ky;
  const fs = 20 + strokeWidth * 2;
  textInput.value = "";
  textInput.style.left = `${lx}px`;
  textInput.style.top = `${ly}px`;
  textInput.style.color = color;
  textInput.style.fontSize = `${fs}px`;
  textInput.classList.add("editing");
  render();
  // 关键：在 mousedown 里立即 focus 会被鼠标交互抢占，导致随后的 blur 把输入框关掉
  // （表现为"点了没反应/输入框一闪而过"）。等事件循环结束再聚焦，确保文本框真正获得焦点。
  setTimeout(() => textInput.focus(), 0);
}

function commitText() {
  if (!textInput.classList.contains("editing")) return;
  const val = textInput.value.replace(/\r/g, "");
  textInput.classList.remove("editing");
  if (!val.trim()) return;

  const r = root.getBoundingClientRect();
  const kx = totalW / r.width,
    ky = totalH / r.height;
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
// blur 提交：点击别处时，有内容则提交、无内容则取消（隐藏）
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
  const parts = s
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const acc: ParsedHotkey = { ctrl: false, alt: false, shift: false, key: "" };
  for (const p of parts) {
    const lp = p.toLowerCase();
    if (
      lp === "ctrl" ||
      lp === "control" ||
      lp === "cmd" ||
      lp === "meta" ||
      lp === "super" ||
      lp === "cmdorctrl"
    ) {
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

  // 滚动截图态优先处理：捕获中 Esc = 停止（保留已捕获），完成态 Esc = 关闭
  if (scrollPhase === "capturing") {
    if (e.key === "Escape") {
      e.preventDefault();
      stopScrollCaptureNow();
    }
    return;
  }
  if (scrollPhase === "done") {
    if (e.key === "Escape") {
      e.preventDefault();
      // 关窗并释放后端的长图缓冲。
      void discardScrollCapture();
      void closeScreenshot();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void finishScrollAction("clipboard");
    }
    return;
  }
  if (scrollPhase === "armed") {
    if (e.key === "Escape") {
      e.preventDefault();
      // 退出语义统一为「关掉」，不再回落到普通截图。
      exitScrollMode();
      return;
    }
    if (e.key === "Enter" && selection && selection.w > 0) {
      e.preventDefault();
      void beginScrollCapture();
      return;
    }
  }

  if (e.key === "Escape") {
    void closeScreenshot();
  } else if (e.key === "Enter") {
    if (selection && selection.w > 0) void exportImage("clipboard");
  } else if (
    matchesHotkey(
      e,
      parseHotkey(copyColorHotkey) ?? { ctrl: true, alt: false, shift: false, key: "c" },
    )
  ) {
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
    if (e.shiftKey) redo();
    else undo();
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
  const oc = requiredContext(out);
  oc.imageSmoothingEnabled = true;

  // 1. 裁剪多屏截图
  blitScreenRegion(oc, screenSources(), sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height);

  // 2. 平移后重绘标注
  oc.save();
  oc.translate(-sel.x, -sel.y);
  for (const s of shapes) {
    if (s.tool === "mosaic") drawMosaic(oc, s);
    else drawAnnotation(oc, s, physScale());
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
  const oc = requiredContext(out);
  oc.imageSmoothingEnabled = true;
  blitScreenRegion(oc, screenSources(), sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height);

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
// 滚动截图（长截图）
//
// 交互：滚动截图专属热键 → 框选区域 → 浮动面板点「开始」→ 后端逐帧捕获拼接
//       → HUD 显示进度与缩略预览 → 完成后 复制 / 保存 / 在查看器中打开。
//
// 捕获期间的关键约束：
// - 选区内的画布必须**保持全透明**：覆盖窗是 transparent(true)，透明像素会透出真实窗口，
//   后端按屏幕像素捕获拿到的才是真内容（否则会把自己的 UI 截进长图里）。
// - 选区外框 / 压暗 / HUD 一律画在选区**之外**，边框还要画在选区边界外侧，
//   避免吃掉边界像素。
// - 后端若选用 SendInput 注入（资源管理器这类不吃滚轮消息的目标），会把覆盖窗临时设为
//   click-through（滚轮要落到底下的目标窗口），此时 HUD 按钮点不到 → 只提示按 Esc 停止。
// ============================================================

type ScrollPhase = "idle" | "armed" | "capturing" | "done";

let scrollPhase: ScrollPhase = "idle";
let scrollProg: ScrollCaptureProgress | null = null;
/** 后端实际使用的捕获区（截图窗内物理坐标）。矮选区会被自动向下补足高度，
 *  前端必须按**它**而不是选区来挖空覆盖窗，否则补出来的那截会截到压暗遮罩
 *  （现象：长图上方亮、下方暗、交界一条绿线）。 */
let scrollCaptureRect: Rect | null = null;
let scrollResult: ScrollCaptureDone | null = null;
/** 会话失败原因（在 armed 态的开始面板上显示） */
let scrollError = "";
/** 结果落地失败原因（复制 / 保存 / 打开）。结果态里开始面板是关着的，所以它必须
 *  由 HUD 渲染 —— 单独一个字段，避免和面板上的会话错误互相覆盖。 */
let scrollActionError = "";
let scrollStopping = false;
/** 从后端真正开始采集到收到结果事件的耗时；恢复中的旧会话没有可靠起点，因此保留为空。 */
let scrollCaptureStartedAt: number | null = null;
let scrollCaptureElapsedMs: number | null = null;
/** 本次会话的模式在启动时锁定，避免捕获过程中切换面板控件造成前后端语义不一致。 */
let scrollManualMode = false;
/** 最近一次上报给后端的「HUD 压在捕获区上」状态（只在变化时发命令；每次进入捕获态复位）。
 *  声明放在这里而不是 `reportHudOverlap` 旁边：多个状态复位函数都会写它。 */
let hudOverlapReported = false;
/** 没有安全落点时，HUD 在整个采集会话中保持隐藏，而不是每帧闪避。 */
let hudHiddenForSession = false;

function scrollPassthrough(): boolean {
  return !!scrollProg?.input_passthrough;
}

function scrollActive(): boolean {
  return scrollPhase === "capturing" || scrollPhase === "done";
}

function formatScrollElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  const display = seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
  return t("shot.scrollElapsedSeconds", { seconds: display });
}

// ---------- 开始面板 ----------
const scrollPanel = document.createElement("div");
scrollPanel.id = "scroll-panel";
scrollPanel.className = "ui-interactive";
const shPanelTitle = document.createElement("div");
shPanelTitle.className = "sh-title";
const shPanelHead = document.createElement("div");
shPanelHead.className = "sh-head";
const shPanelBadge = document.createElement("span");
shPanelBadge.className = "sh-badge";
shPanelHead.append(shPanelTitle, shPanelBadge);
const shModeSwitch = document.createElement("div");
shModeSwitch.className = "sh-mode-switch";
const shAutoModeBtn = document.createElement("button");
shAutoModeBtn.type = "button";
shAutoModeBtn.className = "sh-mode-btn";
const shManualModeBtn = document.createElement("button");
shManualModeBtn.type = "button";
shManualModeBtn.className = "sh-mode-btn";
shModeSwitch.append(shAutoModeBtn, shManualModeBtn);
function makeShMetric() {
  const root = document.createElement("div");
  root.className = "sh-metric";
  const label = document.createElement("div");
  label.className = "sh-metric-label";
  const value = document.createElement("div");
  value.className = "sh-metric-value";
  root.append(label, value);
  return { root, label, value };
}
const shPanelSelectionCard = document.createElement("div");
shPanelSelectionCard.className = "sh-selection-card";
const shPanelSelectionCardHead = document.createElement("div");
shPanelSelectionCardHead.className = "sh-selection-card-head";
const shPanelSelectionLabel = document.createElement("span");
shPanelSelectionLabel.className = "sh-selection-card-label";
const shPanelSelectionState = document.createElement("span");
shPanelSelectionState.className = "sh-selection-card-state";
shPanelSelectionCardHead.append(shPanelSelectionLabel, shPanelSelectionState);
const shPanelSelectionValue = document.createElement("div");
shPanelSelectionValue.className = "sh-selection-card-value";
shPanelSelectionCard.append(shPanelSelectionCardHead, shPanelSelectionValue);
const shPanelHint = document.createElement("div");
shPanelHint.className = "sh-status";
const shPanelActions = document.createElement("div");
shPanelActions.className = "sh-actions";
const shStartBtn = document.createElement("button");
shStartBtn.className = "sh-btn primary";
shStartBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void beginScrollCapture();
});
const shQuitBtn = document.createElement("button");
shQuitBtn.className = "sh-btn";
shQuitBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exitScrollMode();
});
// 可选：从页面顶部开始（默认关 —— 默认就从你当前看到的位置顺着往下截）
const shFromTop = document.createElement("input");
shFromTop.type = "checkbox";
shFromTop.id = "sh-from-top";
const shFromTopLabel = document.createElement("label");
shFromTopLabel.className = "sh-option-row";
shFromTopLabel.htmlFor = "sh-from-top";
// ⚠ `data-i18n` 只能挂在这个 span 上，**绝不能挂在 label 上**：`applyI18n` 会用
// `textContent` 覆盖节点，挂在 label 上会把里面的 checkbox 一起抹掉。
shFromTopLabel.append(shFromTop);
const shFromTopText = document.createElement("span");
shFromTopText.dataset.i18n = "shot.scrollFromTopShort";
shFromTopLabel.append(shFromTopText);

// 模式切换保留原 checkbox 作为唯一数据源，避免启动请求与面板状态脱节。
const shManual = document.createElement("input");
shManual.type = "checkbox";
shManual.id = "sh-manual";
shManual.addEventListener("change", () => syncScrollUi());
shAutoModeBtn.addEventListener("click", () => {
  if (!shManual.checked) return;
  shManual.checked = false;
  syncScrollUi();
});
shManualModeBtn.addEventListener("click", () => {
  if (shManual.checked) return;
  shManual.checked = true;
  syncScrollUi();
});

shPanelActions.append(shStartBtn, shQuitBtn);
scrollPanel.append(
  shPanelHead,
  shModeSwitch,
  shPanelSelectionCard,
  shPanelHint,
  shFromTopLabel,
  shPanelActions,
);
uiLayer.appendChild(scrollPanel);

// 自动滚动时，选区边缘显示 Computer Use 风格的绿色聚焦光晕。
// 支持捕获排除时光晕可内外扩散；兼容路径会在每次采帧前后让它短暂隐藏。
const scrollSelectionGlow = document.createElement("div");
scrollSelectionGlow.id = "scroll-selection-glow";
uiLayer.appendChild(scrollSelectionGlow);

// ---------- 进度 / 结果 HUD ----------
const scrollHud = document.createElement("div");
scrollHud.id = "scroll-hud";
scrollHud.className = "ui-interactive";
const shHudTitle = document.createElement("div");
shHudTitle.className = "sh-title";
// 呼吸红点只创建一次：早期版本在每次进度事件里用 innerHTML 重建整个标题，
// CSS 动画会被反复重启，红点实际上根本不「呼吸」（而且每 ~60ms 重建一次 DOM）。
const shRecDot = document.createElement("span");
shRecDot.className = "sh-rec";
const shHudTitleText = document.createElement("span");
shHudTitle.append(shRecDot, shHudTitleText);
const shHudHead = document.createElement("div");
shHudHead.className = "sh-head";
const shHudBadge = document.createElement("span");
shHudBadge.className = "sh-badge";
shHudHead.append(shHudTitle, shHudBadge);
const shHudMetrics = document.createElement("div");
shHudMetrics.className = "sh-metrics";
const shHudPrimaryMetric = makeShMetric();
const shHudSecondaryMetric = makeShMetric();
shHudMetrics.append(shHudPrimaryMetric.root, shHudSecondaryMetric.root);
const shHudStatus = document.createElement("div");
shHudStatus.className = "sh-status";
const shHudDetail = document.createElement("div");
shHudDetail.className = "sh-detail";
const shPreview = document.createElement("img");
shPreview.className = "sh-preview";
const shResultSummary = document.createElement("div");
shResultSummary.className = "sh-result-summary";
const shResultSizeMetric = document.createElement("div");
shResultSizeMetric.className = "sh-result-metric";
const shResultSizeLabel = document.createElement("span");
shResultSizeLabel.className = "sh-result-metric-label";
const shResultSize = document.createElement("strong");
shResultSizeMetric.append(shResultSizeLabel, shResultSize);
const shResultFramesMetric = document.createElement("div");
shResultFramesMetric.className = "sh-result-metric";
const shResultFramesLabel = document.createElement("span");
shResultFramesLabel.className = "sh-result-metric-label";
const shResultFrames = document.createElement("strong");
shResultFramesMetric.append(shResultFramesLabel, shResultFrames);
shResultSummary.append(shResultSizeMetric, shResultFramesMetric);
const shResultElapsed = document.createElement("div");
shResultElapsed.className = "sh-result-context";
const shPreviewSlot = document.createElement("div");
shPreviewSlot.className = "sh-preview-slot";
shPreviewSlot.appendChild(shPreview);
const shHudActions = document.createElement("div");
shHudActions.className = "sh-actions";
const shResultActions = document.createElement("div");
shResultActions.className = "sh-result-actions";
const shResultBody = document.createElement("div");
shResultBody.className = "sh-result-body";
const shResultSide = document.createElement("div");
shResultSide.className = "sh-result-side";

function makeShBtn(onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "sh-btn";
  b.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

const shStopBtn = makeShBtn(() => stopScrollCaptureNow());
const shCopyBtn = makeShBtn(() => void finishScrollAction("clipboard"));
const shSaveBtn = makeShBtn(() => void finishScrollAction("save"));
const shOpenBtn = makeShBtn(() => void finishScrollAction("open"));
const shEscStop = document.createElement("div");
shEscStop.className = "sh-esc-stop";
shHudActions.append(shStopBtn);
shResultActions.append(shCopyBtn, shSaveBtn, shOpenBtn);
shResultSide.append(shResultSummary, shResultElapsed, shResultActions);
shResultBody.append(shPreviewSlot, shResultSide);
scrollHud.append(
  shHudHead,
  shHudMetrics,
  shHudStatus,
  shHudDetail,
  shEscStop,
  shHudActions,
  shResultBody,
);
uiLayer.appendChild(scrollHud);

// 结果缩略图是异步加载的 data URL。首次切到完成态时它还没有自然尺寸，若只在
// `syncScrollUi` 里落位一次，图片加载后 HUD 会向下变高、把按钮推到屏幕外。
// 观察实际尺寸而非猜预览高度，也能覆盖字体缩放、翻译文案和错误详情导致的尺寸变化。
let scrollHudLayoutPending = false;
function scheduleScrollHudLayout() {
  if (scrollHudLayoutPending) return;
  scrollHudLayoutPending = true;
  window.requestAnimationFrame(() => {
    scrollHudLayoutPending = false;
    if (scrollHud.classList.contains("open")) positionScrollUi();
  });
}
const scrollHudResizeObserver = new ResizeObserver(scheduleScrollHudLayout);
scrollHudResizeObserver.observe(scrollHud);
shPreview.addEventListener("load", scheduleScrollHudLayout);
shPreview.addEventListener("error", scheduleScrollHudLayout);

// 一次性提示条（成功 / 失败）。放在最后 = 叠在面板与 HUD 之上。
const scrollNotice = document.createElement("div");
scrollNotice.id = "scroll-notice";
scrollNotice.className = "ui-interactive";
uiLayer.appendChild(scrollNotice);

/** 进入「待框选」态：清空选区与工具，让用户重新拉框 */
function enterScrollArm() {
  scrollPhase = "armed";
  scrollProg = null;
  scrollCaptureRect = null;
  scrollResult = null;
  scrollError = "";
  scrollActionError = "";
  scrollCaptureStartedAt = null;
  scrollCaptureElapsedMs = null;
  hudOverlapReported = false;
  hudHiddenForSession = false;
  scrollStopping = false;
  scrollManualMode = false;
  selection = null;
  selectedIndex = null;
  setTool(null);
  closePopups();
  // 防御性清理：万一还有未提交的文字标注处于编辑态（正常路径由 blur 提交），
  // 进入新会话时不该把它带进来。
  textInput.classList.remove("editing");
  syncScrollUi();
  render();
}

/** 退出滚动截图：**直接关掉覆盖窗**，不再回落到普通截图模式。
 *
 *  滚动截图是一个独立的流程（专属热键进入、有自己的面板/HUD/结果态），把它和普通截图
 *  混在同一个状态机里会互相串味——用户实测反馈「退出滚动就跑到截图去了」。
 *  现在的语义很干脆：进滚动截图 = 进这个流程；退出 = 关掉。 */
function exitScrollMode() {
  void discardScrollCapture();
  scrollPhase = "idle";
  scrollProg = null;
  scrollCaptureRect = null;
  scrollResult = null;
  scrollError = "";
  scrollActionError = "";
  scrollCaptureStartedAt = null;
  scrollCaptureElapsedMs = null;
  hudOverlapReported = false;
  hudHiddenForSession = false;
  scrollStopping = false;
  scrollManualMode = false;
  scrollSelectionGlow.classList.remove("capture-hidden");
  syncScrollUi();
  void closeScreenshot();
}

// 由开始面板（或 armed 态的 Enter）明确启动，避免用户来不及选择自动/手动模式。
async function beginScrollCapture() {
  const sel = selection;
  if (!sel || sel.w < 32 || sel.h < MIN_SCROLL_SEL_H) {
    // 不给「偷偷补救」，直接说清原因（选区太矮 → 没有重叠区）
    shPanelHint.textContent = scrollSelectionHint();
    shPanelHint.className = "sh-status err";
    return;
  }
  scrollPhase = "capturing";
  scrollProg = null;
  scrollCaptureRect = null;
  scrollResult = null;
  scrollError = "";
  scrollActionError = "";
  scrollCaptureStartedAt = null;
  scrollCaptureElapsedMs = null;
  hudOverlapReported = false;
  hudHiddenForSession = false;
  scrollStopping = false;
  scrollManualMode = shManual.checked;
  scrollSelectionGlow.classList.remove("capture-hidden");
  syncScrollUi();
  render();
  // HUD 已按当前选区完成落位。重叠时优先由 Windows 将整个覆盖窗排除
  // 在捕获结果外，因此 HUD 仍可持续显示；仅 API 不可用时后端才发事件要求隐藏。
  // 等一帧再下发：隐藏帮助框/面板、把覆盖窗底色设为透明这些 DOM 变更必须**先落到屏幕上**，
  // 否则后端抓第一帧时还能看到残留 UI，会被烤进长图顶部（用户实测踩到过）。
  await new Promise((r) => setTimeout(r, 180));
  try {
    scrollCaptureStartedAt = performance.now();
    // 选区坐标是「截图窗内」的物理像素，后端要的是虚拟桌面物理像素 → 加回 minX/minY
    await startScrollCapture({
      x: Math.round(sel.x + minX),
      y: Math.round(sel.y + minY),
      w: Math.round(sel.w),
      h: Math.round(sel.h),
      mode: scrollManualMode ? "manual" : "auto",
      // 默认 false：从当前可见位置往下截；勾了才先滚到页面顶部
      auto_scroll_top: !scrollManualMode && shFromTop.checked,
      // 自动滚动的光晕会向选区内扩散：优先排除整个覆盖窗；老系统回退为逐帧隐藏光晕。
      // HUD 真正重叠时仍沿用原有的整段隐藏兜底。
      hide_hud_during_capture: hudOverlapReported,
      hide_glow_during_capture: !scrollManualMode,
    });
  } catch (e) {
    hudHiddenForSession = false;
    scrollHud.classList.remove("hud-hidden");
    scrollSelectionGlow.classList.remove("capture-hidden");
    scrollError = String(e);
    scrollCaptureStartedAt = null;
    scrollCaptureElapsedMs = null;
    scrollPhase = "armed";
    syncScrollUi();
    render();
  }
}

function stopScrollCaptureNow() {
  if (scrollPhase !== "capturing" || scrollStopping) return;
  scrollStopping = true;
  syncScrollUi();
  void stopScrollCaptureCmd();
}

/** 结果落地（复制 / 保存 / 在查看器中打开）。
 *
 *  成功：给出明确的成功反馈（toast），而不是「窗口无声无息地消失」——用户需要确认
 *  图到底存到哪了。`save` 交给后端存到桌面并把路径 toast 出来，然后才关窗。
 *
 *  失败：**必须**把原因显示出来。结果态里开始面板是关着的，能显示信息的地方只有
 *  HUD，所以这里把消息写进 `scrollActionError` 并由 HUD 渲染（早期版本只写 `scrollError`，
 *  而那个字段只在 armed 态的面板上渲染 → 失败时界面毫无反应，看起来像点了个假按钮）。 */
async function finishScrollAction(action: "save" | "clipboard" | "open") {
  try {
    const path = await finishScrollCaptureCmd(action);
    if (action === "clipboard") {
      showScrollNotice(t("shot.scrollCopied"));
      return; // 复制不关窗：用户可能还想接着保存 / 打开
    }
    if (action === "save") {
      showScrollNotice(path ? t("shot.savedTo", { path }) : t("shot.scrollSaved"));
    }
    await closeScreenshot();
  } catch (e) {
    scrollActionError = t(
      action === "open"
        ? "shot.scrollOpenFailed"
        : action === "save"
          ? "shot.scrollSaveFailed"
          : "shot.scrollCopyFailed",
      { msg: String(e) },
    );
    // 双通道：HUD 上常驻显示（用户看得见的地方）+ 一次性提示条（即使 HUD 被隐藏也在）
    showScrollNotice(scrollActionError, true);
    syncScrollUi();
    render();
  }
}

/** 覆盖窗里的一次性提示条（成功/失败）。
 *
 *  截图窗**没有**主窗口那套 toast —— 结果态的失败原因必须有地方显示，
 *  否则「保存失败」对用户来说就是一次无声的点击。 */
let scrollNoticeTimer: number | undefined;
function showScrollNotice(text: string, isError = false) {
  scrollNotice.textContent = text;
  scrollNotice.classList.toggle("err", isError);
  scrollNotice.classList.add("on");
  placeScrollNotice();
  if (scrollNoticeTimer !== undefined) window.clearTimeout(scrollNoticeTimer);
  scrollNoticeTimer = window.setTimeout(
    () => scrollNotice.classList.remove("on"),
    isError ? 6000 : 2200,
  );
}

/** 提示条固定落在**选区之外**的那块显示器底部居中（放不下就退回顶部居中） */
function placeScrollNotice() {
  if (!scrollNotice.classList.contains("on")) return;
  const box = scrollCaptureRect ?? selection;
  const monitor = box ? monitorBoxCss(box) : rootBoxCss();
  const w = scrollNotice.offsetWidth || 320;
  const h = scrollNotice.offsetHeight || 40;
  const minX = monitor.x + 10;
  const maxX = Math.max(minX, monitor.x + monitor.w - w - 10);
  const x = Math.max(minX, Math.min(monitor.x + (monitor.w - w) / 2, maxX));
  let y = monitor.y + monitor.h - h - 16;
  if (box) {
    // 与捕获区相交就翻到显示器顶部（提示条本身也可能被截进长图）
    const region = toCssBox(box);
    if (overlaps({ x, y, w, h }, region)) {
      const top = monitor.y + 16;
      if (!overlaps({ x, y: top, w, h }, region)) y = top;
    }
  }
  scrollNotice.style.left = `${x}px`;
  scrollNotice.style.top = `${y}px`;
}

/** 依据 scrollPhase 刷新面板 / HUD 的显隐、文案与按钮可用性 */
/** 小于此高度没有足够空间容纳一次滚动与最小重叠区。
 * 与后端 `MIN_SELECTION_H` 保持一致（前端先拦，用户能立刻看到原因）。 */
const MIN_SCROLL_SEL_H = 280;
/** 这是体验上的推荐值，不再是硬门槛。实际可否拼接由首次滚动测出的位移决定。 */
const RECOMMENDED_SCROLL_SEL_H = 400;

/** 选区是否满足滚动截图的最小高度要求 */
function scrollSelectionOk(): boolean {
  return !!selection && selection.w >= 32 && selection.h >= MIN_SCROLL_SEL_H;
}

/** 选区不符要求时的说明文案（面板上直接显示原因，不要只把按钮置灰） */
function scrollSelectionHint(): string {
  if (!selection) return t("shot.scrollHint");
  if (selection.h < MIN_SCROLL_SEL_H) {
    return t("shot.scrollTooShort", {
      h: Math.round(selection.h),
      min: MIN_SCROLL_SEL_H,
    });
  }
  if (selection.h < RECOMMENDED_SCROLL_SEL_H) {
    return t("shot.scrollShortCaution", {
      h: Math.round(selection.h),
      recommended: RECOMMENDED_SCROLL_SEL_H,
    });
  }
  return t("shot.scrollHint");
}

function syncScrollUi() {
  const inScroll = scrollPhase !== "idle";

  // 滚动模式下覆盖窗的「底色」必须让开：screenshot.html 给 #screenshot-root 铺了一层
  // 不透明深色（多屏空白处避免透出活桌面），但捕获期间选区必须是**真透明** —— 否则按屏幕
  // 像素捕获截到的永远是我们自己那层深色底，目标画面一帧都不会变，探针直接判「滚不动」。
  // （P1 端到端实测踩到：命令行探针没有覆盖窗，所以一直没暴露。）
  root.style.background = inScroll ? "transparent" : "";

  // 普通截图工具栏在滚动模式下整体让位
  toolbar.style.display = inScroll || !selection ? "none" : "flex";
  if (inScroll) {
    helpBox.style.display = "none";
    closePopups();
    ctx0ClearOcr();
  } else {
    helpBox.style.display = "";
  }

  // 与普通截图一致：专属快捷键唤起后先只显示干净的框选画面。
  // 滚动截图的准备面板要等用户完成选区后才出现，避免在多屏初始阶段
  // 跑到另一块显示器，也避免打断用户先确定捕获范围的动作。
  scrollPanel.classList.toggle("open", scrollPhase === "armed" && !!selection);
  scrollHud.classList.toggle("open", scrollActive());
  scrollHud.classList.toggle("clickthrough", scrollPassthrough());
  scrollSelectionGlow.classList.toggle(
    "on",
    scrollPhase === "capturing" && !scrollManualMode && scrollProg?.method !== "manual",
  );
  // 采帧让位是**瞬时**状态（后端每帧 emit 一次 hidden=true/false）。一旦离开捕获态
  // 就必须清掉，否则「最后一帧的 hidden=true 比 done 事件晚到」或「会话异常结束」时，
  // 这个类会一直留在 HUD 上 —— 现象是长图缩略预览与结果按钮全都不显示（visibility:hidden）。
  if (scrollPhase !== "capturing") {
    scrollHud.classList.remove("hud-hidden");
    scrollSelectionGlow.classList.remove("capture-hidden");
  }
  // 选好区域后才显示面板；选区不合要求时「开始」不可点，并且**直接说明原因**
  // （选区太矮 = 没有重叠区，拼不了）——而不是把按钮置灰让用户猜。
  shStartBtn.disabled = !scrollSelectionOk();
  // 手动模式不允许「从顶部开始」：它不应在用户不知情时移动目标内容。
  shFromTop.disabled = shManual.checked;
  shFromTopLabel.style.display = shManual.checked ? "none" : "flex";
  const selTooShort = !!selection && selection.h < MIN_SCROLL_SEL_H;
  const selShortCaution =
    !!selection && selection.h >= MIN_SCROLL_SEL_H && selection.h < RECOMMENDED_SCROLL_SEL_H;

  shPanelTitle.textContent = t("shot.scroll");
  shPanelBadge.textContent = t("shot.scrollReady");
  shPanelBadge.className = "sh-badge ok";
  shAutoModeBtn.textContent = t("shot.scrollAutoMode");
  shManualModeBtn.textContent = t("shot.scrollManualModeShort");
  shAutoModeBtn.classList.toggle("active", !shManual.checked);
  shManualModeBtn.classList.toggle("active", shManual.checked);
  shAutoModeBtn.setAttribute("aria-pressed", String(!shManual.checked));
  shManualModeBtn.setAttribute("aria-pressed", String(shManual.checked));
  shPanelSelectionCard.style.display = selection ? "flex" : "none";
  shPanelSelectionLabel.textContent = t("shot.scrollSelectionLabel");
  shPanelSelectionValue.textContent = selection
    ? `${Math.round(selection.w)} × ${Math.round(selection.h)} px`
    : "—";
  shPanelSelectionState.textContent = selTooShort
    ? `≥ ${MIN_SCROLL_SEL_H}px`
    : selection && selection.h >= RECOMMENDED_SCROLL_SEL_H
      ? t("shot.scrollHeightReady")
      : `≥ ${RECOMMENDED_SCROLL_SEL_H}px`;
  shPanelSelectionState.className = `sh-selection-card-state${
    selection && selection.h >= RECOMMENDED_SCROLL_SEL_H ? " ok" : " warn"
  }`;
  shPanelHint.textContent = scrollError
    ? t("shot.scrollFailed", { msg: scrollError })
    : selTooShort || selShortCaution
      ? scrollSelectionHint()
      : shManual.checked
        ? t("shot.scrollManualHint")
        : t("shot.scrollAutoHint");
  shPanelHint.className = `sh-status${scrollError || selTooShort ? " err" : selShortCaution ? " warn" : ""}`;
  shStartBtn.textContent = shManual.checked ? t("shot.scrollManualStart") : t("shot.scrollStart");
  shQuitBtn.textContent = t("shot.scrollCancel");

  // ---- HUD ----
  const p = scrollProg;
  const res = scrollResult;
  if (scrollPhase === "capturing") {
    scrollHud.classList.remove("result");
    shResultSummary.style.display = "none";
    shResultBody.style.display = "none";
    shHudActions.style.display = "flex";
    const manual = scrollManualMode || p?.method === "manual";
    // REC 手感：呼吸红点 + 标题（扫一眼就知道在录；边框颜色/任务栏进度是补充通道）
    shRecDot.style.display = "";
    shHudTitleText.textContent = manual
      ? t("shot.scrollManualCapturing")
      : t("shot.scrollCapturing");
    const stage = p?.stage === "probing" ? t("shot.scrollProbing") : "";
    const low = p?.stage === "low_confidence" ? t("shot.scrollStageLow") : "";
    shHudBadge.textContent = scrollStopping
      ? t(manual ? "shot.scrollManualFinishing" : "shot.scrollStopping")
      : stage || (manual ? t("shot.scrollManualBadge") : t("shot.scrollCapturing"));
    shHudBadge.className = `sh-badge${low ? " warn" : " recording"}`;
    shHudMetrics.style.display = "grid";
    shHudPrimaryMetric.label.textContent = t("shot.scrollCaptured");
    shHudPrimaryMetric.value.textContent = p && p.height > 0 ? `${p.height}px` : "—";
    shHudSecondaryMetric.label.textContent = t("shot.scrollFrameCount");
    shHudSecondaryMetric.value.textContent = p ? String(p.frames) : "—";
    shHudStatus.textContent = scrollStopping
      ? t(manual ? "shot.scrollManualFinishing" : "shot.scrollStopping")
      : "";
    shHudStatus.className = `sh-status${low ? " warn" : ""}`;
    const detail = low || stage || p?.message || "";
    shHudDetail.textContent = detail;
    shHudDetail.className = `sh-detail${detail ? " on" : ""}${low ? " warn" : ""}`;
    shPreview.classList.remove("on");
    shStopBtn.style.display = scrollPassthrough() ? "none" : "";
    shStopBtn.disabled = scrollStopping;
    shStopBtn.textContent = t(manual ? "shot.scrollManualFinish" : "shot.scrollStop");
    shEscStop.textContent = t(manual ? "shot.scrollManualEscFinish" : "shot.scrollEscStop");
    shEscStop.classList.toggle("on", scrollPassthrough());
  } else if (scrollPhase === "done" && res) {
    scrollHud.classList.add("result");
    shHudActions.style.display = "none";
    shResultSummary.style.display = "grid";
    shResultBody.style.display = "grid";
    shRecDot.style.display = "none";
    shHudTitleText.textContent = t("shot.scrollDone");
    const conf =
      res.confidence === "high"
        ? t("shot.scrollConfHigh")
        : res.confidence === "partial"
          ? t("shot.scrollConfPartial")
          : t("shot.scrollConfLow");
    shHudBadge.textContent = conf;
    shHudBadge.className = `sh-badge${res.confidence === "high" ? " ok" : " warn"}`;
    shHudMetrics.style.display = "none";
    shResultSizeLabel.textContent = t("shot.scrollDimensions");
    shResultSize.textContent = t("shot.scrollSize", {
      w: res.width ?? 0,
      h: res.height ?? 0,
    });
    shResultFramesLabel.textContent = t("shot.scrollFrameCount");
    shResultFrames.textContent = t("shot.scrollFrames", { count: res.frames ?? 0 });
    shResultElapsed.style.display = scrollCaptureElapsedMs === null ? "none" : "";
    shResultElapsed.textContent =
      scrollCaptureElapsedMs === null
        ? ""
        : t("shot.scrollElapsed", { time: formatScrollElapsed(scrollCaptureElapsedMs) });
    shHudStatus.textContent = scrollActionError;
    shHudStatus.className = `sh-status${scrollActionError ? " err" : ""}`;
    // 落地失败时把原因顶到最前面：`res.message` 是拼接阶段的信息，此刻更重要的是「为什么没存下来」
    shHudDetail.textContent = scrollActionError || res.message || "";
    shHudDetail.className = `sh-detail${scrollActionError || res.message ? " on" : ""}${res.confidence === "high" && !scrollActionError ? "" : " warn"}`;
    shEscStop.classList.remove("on");
    const hasPreview = !!scrollProg?.preview;
    shPreview.classList.toggle("on", hasPreview);
    shPreviewSlot.style.display = hasPreview ? "grid" : "none";
    shResultBody.classList.toggle("without-preview", !hasPreview);
    if (scrollProg?.preview) shPreview.src = scrollProg.preview;
    shCopyBtn.classList.remove("primary");
    shSaveBtn.classList.remove("primary");
    shOpenBtn.classList.add("primary");
    shCopyBtn.textContent = t("shot.scrollCopy");
    shSaveBtn.textContent = t("shot.scrollSave");
    shOpenBtn.textContent = t("shot.scrollOpen");
  }

  positionScrollUi();
}

// ---------- 滚动截图面板 / HUD 的落位 ----------
//
// 坐标系统一：`selection` / `scrollCaptureRect` 都是**截图窗内物理像素**，而
// `element.style.left/top` 要的是 **CSS 像素**。两者差一个 `physScale()`，
// 混用会把面板算到别的显示器上去（用户实测：「提示框跑到第二个屏幕」）。
// 本节的规矩：**几何计算一律在 CSS 像素里做，入口处一次性换算**。
//
// 另一条约束：覆盖窗铺满整个虚拟桌面，捕获区是画布上**挖空的透明洞**。
// 落在洞里的 UI 会被后端按屏幕像素截进长图（必须避免），落在洞外的会被自己的
// 压暗遮罩盖住（更难看）——所以浮层位置**只在「选区所在那块显示器」内挑**，
// 且优先挑洞外；实在没地方才落回洞内角落，并且由后端在采帧时让开（见
// `scroll-capture-hud` 事件）。

interface CssBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 物理像素矩形 → 截图窗内 CSS 矩形 */
function toCssBox(r: Rect): CssBox {
  const b = root.getBoundingClientRect();
  const kx = b.width / Math.max(totalW, 1);
  const ky = b.height / Math.max(totalH, 1);
  return { x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky };
}

/** 覆盖窗整体（CSS） */
function rootBoxCss(): CssBox {
  const b = root.getBoundingClientRect();
  return { x: 0, y: 0, w: b.width, h: b.height };
}

/** 选区 / 捕获区**所在那块显示器**在截图窗内的 CSS 矩形。
 *
 *  浮层只在这块屏里摆：多屏时若按整个虚拟桌面（= 覆盖窗）夹取，
 *  面板会被算到另一块屏幕上（用户实测：「跑到第二块屏幕」）。
 *  注意 `screens[].x/y/w/h` 是 root-local **物理**像素，比尺寸时不能用 CSS 的 root 宽度。 */
function monitorBoxCss(anchor: Rect | null): CssBox {
  const all = rootBoxCss();
  if (!anchor || screens.length === 0) return all;
  const cx = anchor.x + anchor.w / 2;
  const cy = anchor.y + anchor.h / 2;
  const hit = screens.find((s) => cx >= s.x && cx < s.x + s.w && cy >= s.y && cy < s.y + s.h);
  if (!hit) return all;
  const b = root.getBoundingClientRect();
  const kx = b.width / Math.max(totalW, 1);
  const ky = b.height / Math.max(totalH, 1);
  return { x: hit.x * kx, y: hit.y * ky, w: hit.w * kx, h: hit.h * ky };
}

/** 在选区四周评估多个落点。优先完全避开捕获区，其次才是离首选锚点更近。
 * 这比「先横移、再纵移」的贪心路径稳定，浮层文字/预览尺寸改变时也不容易跳到另一侧。 */
function placeScrollUi(
  el: HTMLElement,
  region: CssBox,
  monitor: CssBox,
  kind: "panel" | "hud",
): void {
  const w = el.offsetWidth || 280;
  const h = el.offsetHeight || 100;
  const point = placeScrollOverlay(region, monitor, { w, h }, kind);
  el.style.left = `${point.x}px`;
  el.style.top = `${point.y}px`;
}

/** 将自动滚动的聚焦光晕严格放在捕获区外侧，避免任何发光像素进入截图源。 */
function positionScrollSelectionGlow(region: CssBox) {
  if (!scrollSelectionGlow.classList.contains("on")) return;
  // 伪元素最小 inset 为 19px，外层 shadow 只向外投射；内侧仍保留 19px 空隙。
  const outerGap = 50;
  scrollSelectionGlow.style.cssText = `left:${region.x - outerGap}px;top:${region.y - outerGap}px;width:${region.w + outerGap * 2}px;height:${region.h + outerGap * 2}px`;
}

/** 依据当前捕获区摆放开始面板与进度 / 结果 HUD */
function positionScrollUi() {
  // 以「实际捕获区」为准（它可能比用户选区高）
  const box = scrollCaptureRect ?? selection;
  if (!box) return;
  const region = toCssBox(box);
  const monitor = monitorBoxCss(box);
  positionScrollSelectionGlow(region);
  // 开始面板：贴着选区下沿（在选区外，不会被截进长图）
  if (scrollPanel.classList.contains("open")) {
    placeScrollUi(scrollPanel, region, monitor, "panel");
  }
  // 进度 / 结果 HUD：本屏右上角固定位置（「提示框」语义：位置稳定、永远看得见）
  if (scrollHud.classList.contains("open")) {
    placeScrollUi(scrollHud, region, monitor, "hud");
    reportHudOverlap(region);
  }
  // 一次性提示条：尺寸/位置随捕获区变化重算
  placeScrollNotice();
}

/** 本屏内实在没有「捕获区之外」的落脚点时，HUD 只能压在捕获区上。
 *  这个判定会随启动请求交给后端，用于尝试排除整个覆盖窗。 */
function reportHudOverlap(region: CssBox) {
  const w = scrollHud.offsetWidth || 280;
  const h = scrollHud.offsetHeight || 100;
  const x = Number.parseFloat(scrollHud.style.left) || 0;
  const y = Number.parseFloat(scrollHud.style.top) || 0;
  const on = overlaps({ x, y, w, h }, region);
  if (on === hudOverlapReported) return;
  hudOverlapReported = on;
}

/**
 * 捕获/完成态的画布：整屏压暗 → **挖空选区**（透明，透出真实窗口）→ 选区外框。
 * 采集进行中绝不绘制边框：即使它理论上压在捕获区外，混合 DPI/整屏选区的边界
 * 取整仍可能让一像素绿线被 BitBlt 带进结果。
 */
function renderScrollOverlay() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!selection) return;
  const s = selection;
  // 「挖空」按**后端实际捕获区**来：矮选区会被自动向下补足，补出来的那截如果不挖空，
  // 就会截到我们自己的压暗遮罩 + 绿边（用户实测报回「上方亮下方暗、中间一条绿线」）。
  const cap = scrollCaptureRect ?? selection;
  // 绿线必须完全落在捕获区外，避免烤进长图；保留 1px 安全边即可，
  // 不再像此前的 2px 那样看起来比窗口四周都大一圈。
  const grow = physScale();
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.clearRect(cap.x - grow, cap.y - grow, cap.w + grow * 2, cap.h + grow * 2);

  if (scrollPhase !== "capturing") {
    const lw = physScale();
    const color =
      scrollProg?.stage === "low_confidence" ? "#ffb300" : scrollError ? "#ff5252" : "#00ff00";

    // 结果态才重画用户框；此时后台已经不再采集，边框不可能进入长图。
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeRect(s.x - grow / 2, s.y - grow / 2, s.w + grow, s.h + grow);
  }
}

/** OCR 面板在滚动模式里要让位（否则会压在选区上/干扰视线） */
function ctx0ClearOcr() {
  ocrPanel.style.display = "none";
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
    // 打开时把原生取色条同步成当前颜色
    if (nativeColorInput) nativeColorInput.value = color;
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
  if (
    colorPopup.contains(t) ||
    widthPopup.contains(t) ||
    colorBtn.contains(t) ||
    widthBtn.contains(t)
  ) {
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

  // 清旧状态（旧 img 元素 + 标注历史）。
  // ⚠ 用 `:scope > img` 只清 root 的**直接子** img：曾经的 `querySelectorAll("img")`
  // 会连 HUD 里的结果缩略预览（#scroll-hud 内的 img）一起删掉，于是预览永远不显示。
  root.querySelectorAll(":scope > img").forEach((el) => {
    el.remove();
  });
  shapes = [];
  history.clear();
  selection = null;
  dragStart = dragCur = null;
  dragMode = "none";
  curShape = null;
  selectedIndex = null;
  hoverWin = null;
  pendingWinSelect = null;
  // 重置工具选择：否则上次用过的画笔会跨会话保留，下次 Alt+S 进入直接是
  // 画笔态（点哪画哪，无法拉选区）。每次新截图都从「无工具 / 选区模式」开始。
  tool = null;
  for (const b of toolBtns.values()) b.classList.toggle("active", false);
  hoverIndex = null;
  moveStart = null;
  moveOrigShape = null;
  resizeOrig = null;
  resizeHistorySnapshot = null;
  resizeHandle = -1;
  moveSelectionStart = null;
  moveSelectionOrig = null;
  textInput.classList.remove("editing");
  ocrPanel.style.display = "none";
  screens = [];
  // 截图窗口会复用。帮助框优先锚定 lastMousePos；若不在这里清掉，
  // 下一次 Alt+S 的首帧会沿用上一次截图结束时的鼠标位置，双屏下就会
  // 先跑到另一块屏幕。初始位置应当使用本次 capture 时后端记录的 cursor。
  lastMousePos = null;
  overUI = false;

  // 新的截图会话：滚动截图状态全部归零（后端结果也丢弃）
  scrollPhase = "idle";
  scrollProg = null;
  scrollCaptureRect = null;
  scrollResult = null;
  scrollError = "";
  scrollActionError = "";
  scrollCaptureStartedAt = null;
  scrollCaptureElapsedMs = null;
  hudOverlapReported = false;
  hudHiddenForSession = false;
  scrollStopping = false;
  scrollManualMode = false;
  shManual.checked = false;
  void discardScrollCapture();
  syncScrollUi();

  totalW = data.total_width;
  totalH = data.total_height;
  minX = data.min_x;
  minY = data.min_y;
  initialCursorPos = data.cursor ? { x: data.cursor.x - minX, y: data.cursor.y - minY } : null;

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
    // 不再把 <img> 插入 DOM 拼接（那是亚像素细缝与跨屏空白露馅的根源），改由
    // render() 的 drawBase() 把各屏按精确整数物理坐标合成到画布上。img 仅作为
    // blitRegion/放大镜/马赛克/导出 的像素源保留在 screens[] 里（解码后常驻内存）。
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
    "[screenshot] bounds",
    data.min_x,
    data.min_y,
    data.total_width,
    data.total_height,
    "scale",
    physScale().toFixed(2),
    "screens",
    data.screens.length,
  );
  // 一次性诊断：完整 viewport + 每屏 img 状态，在跨屏/混合 DPI 异常时可一眼定位。
  // 数据来源完全靠前端能拿到的字段（getBoundingClientRect + data.monitor_info），
  // 正常运行时零开销。
  const rr = root.getBoundingClientRect();
  console.info(
    "[screenshot] viewport:",
    JSON.stringify({
      totalW,
      totalH,
      minX: data.min_x,
      minY: data.min_y,
      rootW: +rr.width.toFixed(1),
      rootH: +rr.height.toFixed(1),
      rootLeft: +rr.left.toFixed(1),
      rootTop: +rr.top.toFixed(1),
      dpr: window.devicePixelRatio,
      physScale: +physScale().toFixed(4),
      canvasAttr: `${canvas.width}x${canvas.height}`,
      canvasCss: `${+canvas.getBoundingClientRect().width.toFixed(1)}x${+canvas.getBoundingClientRect().height.toFixed(1)}`,
      monitors: data.monitor_info,
    }),
  );

  render();

  // 恢复「后端仍在跑」的界面状态：窗口被复用打开时（例如用户在长截图途中又按了 Alt+S），
  // 后端的会话还在继续，但前端是全新的 idle 状态 —— 不同步的话覆盖窗上什么都没有，
  // 而且它铺满屏幕、置顶，会把正在被截取的目标窗口挡住，用户只能看到一块压暗的遮罩。
  await restoreRunningScrollSession();

  // 首帧就绪：CSS/布局完成后再显示，避免初始化期间 FOUC（元素挤在左上角）
  if (!document.body.classList.contains("ready")) {
    document.body.classList.add("ready");
  }
}

/** 后端会话仍在跑时，把前端切回捕获态并拉一次最新进度（事件之外的兜底查询）。
 *
 *  这同时是 `scroll_capture_progress` 这条命令存在的意义：进度事件在窗口关闭期间
 *  是**丢失**的，只有主动拉取才能把 HUD 立刻填上正确数字。 */
async function restoreRunningScrollSession() {
  try {
    if (!(await scrollCaptureRunning())) return;
    scrollPhase = "capturing";
    scrollStopping = false;
    // 重连的旧会话没有可信的起始时间，避免展示一段错误的“耗时”。
    scrollCaptureStartedAt = null;
    scrollCaptureElapsedMs = null;
    scrollProg = await scrollCaptureProgress();
    const cap = scrollProg?.capture;
    scrollCaptureRect = cap ? { x: cap[0] - minX, y: cap[1] - minY, w: cap[2], h: cap[3] } : null;
    syncScrollUi();
    render();
  } catch {
    // 查不到就按普通截图处理，不影响主流程
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
  // 提示框里「取色热键」要显示配置里的实际键值，放大镜关闭时整行隐藏
  updateHelpBox();
}

// 截图窗口 UI 主题：与主窗口一致，跟随 config.theme（dark / light / system），
// 由 screenshot.html 里 :root[data-theme] 变量驱动工具栏/弹窗/帮助框/OCR 面板配色。
function applyTheme(theme: "dark" | "light" | "system") {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

async function main() {
  await refreshConfig();

  // 后端复用窗口时 main() 不会重跑，但会 emit screenshot-refresh 触发 loadScreenshot；
  // 此处重读配置再重载，否则复用窗口下「截图放大镜」等设置不生效。
  await listen("screenshot-refresh", async () => {
    await refreshConfig();
    await loadScreenshot();
    // 渲染完成 → 通知后端显示窗口（避免冷启动白屏/始终置顶锁屏）
    await screenshotUiReady();
    // 复用窗口时 main() 不会重跑，启动模式也要在这里取一次
    await applyScrollStartMode();
  });

  // 后端隐藏窗口前 emit：清掉画面，避免下次 show 时闪旧截图
  await listen("screenshot-clear", () => {
    // 同 loadScreenshot：只清 root 的直接子 img，别误删 HUD 里的结果缩略预览
    root.querySelectorAll(":scope > img").forEach((el) => {
      el.remove();
    });
    screens = [];
    shapes = [];
    history.clear();
    selection = null;
    curShape = null;
    dragStart = dragCur = null;
    dragMode = "none";
    selectedIndex = null;
    resizeOrig = null;
    resizeHistorySnapshot = null;
    resizeHandle = -1;
    hoverWin = null;
    pendingWinSelect = null;
    ocrPanel.style.display = "none";
    textInput.classList.remove("editing");
    moveSelectionStart = null;
    moveSelectionOrig = null;
    scrollPhase = "idle";
    scrollProg = null;
    scrollCaptureRect = null;
    scrollResult = null;
    scrollError = "";
    scrollActionError = "";
    scrollCaptureStartedAt = null;
    scrollCaptureElapsedMs = null;
    hudOverlapReported = false;
    hudHiddenForSession = false;
    scrollStopping = false;
    scrollManualMode = false;
    shManual.checked = false;
    syncScrollUi();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    document.body.classList.remove("ready");
  });

  // 滚动截图：进度事件（帧数/高度/注入方式/缩略预览）
  await listen<ScrollCaptureProgress>("scroll-capture-progress", (e) => {
    scrollProg = e.payload;
    scrollStopping = e.payload.stage === "finishing";
    if (e.payload.method === "manual") scrollManualMode = true;
    // 后端上报的实际捕获区（虚拟桌面物理像素）→ 转成截图窗内坐标
    const cap = e.payload.capture;
    scrollCaptureRect = cap ? { x: cap[0] - minX, y: cap[1] - minY, w: cap[2], h: cap[3] } : null;
    syncScrollUi();
    render();
  });

  // 捕获排除不受支持时：HUD 的重叠兜底会保持隐藏到结束；内扩光晕只在 BitBlt 前后瞬时隐藏。
  await listen<{ hidden: boolean; hud?: boolean; glow?: boolean }>("scroll-capture-hud", (e) => {
    const hidden = !!e.payload?.hidden;
    const hidesHud = e.payload?.hud !== false;
    if (hidesHud) {
      if (hidden) hudHiddenForSession = true;
      if (!hidden && hudHiddenForSession && scrollPhase === "capturing") return;
      scrollHud.classList.toggle("hud-hidden", hidden);
    }
    if (e.payload?.glow) scrollSelectionGlow.classList.toggle("capture-hidden", hidden);
  });

  // 滚动截图：结束事件（成功 → 结果态；失败 → 回 armed 态并显示原因）
  await listen<ScrollCaptureDone>("scroll-capture-done", (e) => {
    const p = e.payload;
    const startedAt = scrollCaptureStartedAt;
    scrollCaptureStartedAt = null;
    scrollCaptureElapsedMs = p.ok && startedAt !== null ? performance.now() - startedAt : null;
    scrollStopping = false;
    hudHiddenForSession = false;
    scrollHud.classList.remove("hud-hidden");
    scrollSelectionGlow.classList.remove("capture-hidden");
    // 结果事件与最后一条进度事件跨线程投递，顺序不能假设。无论后端最后一条
    // 进度是否已标记终态，结果 HUD 都必须重新接收鼠标点击。
    if (scrollProg) scrollProg = { ...scrollProg, input_passthrough: false };
    scrollHud.classList.remove("clickthrough");
    if (p.ok) {
      scrollResult = p;
      scrollPhase = "done";
    } else {
      scrollError = p.message || "";
      scrollPhase = "armed";
      // 保留选区：滚动面板以选区为显示锚点。此前这里清掉选区，导致失败原因
      // 虽已收到却没有地方显示，直到下一次点击重新选中才会“补出现”。
    }
    syncScrollUi();
    render();
  });

  await loadScreenshot();
  // 渲染完成 → 通知后端显示窗口（避免冷启动白屏/始终置顶锁屏）
  await screenshotUiReady();
  await applyScrollStartMode();
}

/**
 * 后端在唤起覆盖窗前记录了「这次是否滚动截图模式」（Alt+Shift+S 触发的）。
 * 取走即清（一次性），是则直接进入待框选态 —— 用户按一次热键就能开始框，
 * 不必先 Alt+S 再切模式（对齐 ShareX 的独立滚动截图热键）。
 */
async function applyScrollStartMode() {
  try {
    if (await takeScrollStartMode()) {
      // 专属热键进来的：覆盖窗就是为滚动截图而开，进来直接是待框选态
      enterScrollArm();
      syncScrollUi();
    }
  } catch {
    // 读不到就按普通截图处理
  }
}

void main();

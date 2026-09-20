import {
  closeScreenshot,
  copyText,
  discardScrollCapture,
  pickWindowAt,
  scrollCaptureProgress,
  scrollCaptureRunning,
  takeScrollStartMode,
  type ScrollCaptureDone,
  type ScrollCaptureProgress,
} from "./api";
import { applyI18n, setLang, t } from "./i18n";
import { createToolbar } from "./screenshot/toolbar";
import { createHelpPanel, createOcrPanel } from "./screenshot/panels";
import { createMagnifierRenderer } from "./screenshot/magnifier";
import { createTextInputController } from "./screenshot/text-input";
import { createEditorCanvasRenderer } from "./screenshot/editor-renderer";
import { bindEditorShortcuts } from "./screenshot/editor-shortcuts";
import { createEditorInputController } from "./screenshot/editor-input";
import { createScreenshotActionController } from "./screenshot/screenshot-action-controller";
import { createScrollCaptureHud } from "./screenshot/scroll-capture-hud";
import { createScrollCaptureStartPanel } from "./screenshot/scroll-capture-panel";
import {
  createScrollCapturePositioner,
  renderScrollCaptureOverlay,
} from "./screenshot/scroll-capture-layout";
import { createScrollCaptureSession } from "./screenshot/scroll-capture-session";
import { createScrollCaptureController } from "./screenshot/scroll-capture-controller";
import { refreshScreenshotConfig, startScreenshotLifecycle } from "./screenshot/lifecycle";
import { createScreenshotLoadController } from "./screenshot/screenshot-load-controller";
import { createEditorUiController } from "./screenshot/editor-ui-controller";
import { createEditorSession } from "./screenshot/editor-session";
import {
  isShapeHit,
  normRect,
  shapeHandles,
  type Pt,
  type Rect,
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
let editorInput: ReturnType<typeof createEditorInputController>;
let scrollPositioner: ReturnType<typeof createScrollCapturePositioner>;
let scrollController: ReturnType<typeof createScrollCaptureController>;
let screenshotLoadController: ReturnType<typeof createScreenshotLoadController>;
let editorUi: ReturnType<typeof createEditorUiController>;
let screenshotActions: ReturnType<typeof createScreenshotActionController>;

// 物理像素 / CSS 像素 —— 实时计算（不再用 devicePixelRatio 单值，
// multi-monitor mixed-DPI 时单值不可靠，会让 outer frame 与 inner viewport 比例同步错位）。
function physScale(): number {
  if (totalW <= 0) return 1;
  const w = root.getBoundingClientRect().width;
  return w > 0 ? totalW / w : 1;
}
// ---------- 状态 ----------
let totalW = 0;
let totalH = 0;
let minX = 0;
let minY = 0;
let screens: { img: HTMLImageElement; x: number; y: number; w: number; h: number }[] = [];

const mosaicWidth = DEFAULT_MOSAIC;
const editorSession = createEditorSession({ color: DEFAULT_COLOR, strokeWidth: DEFAULT_STROKE });

// ---------- 放大镜 ----------
let magnifierActive = true; // 读 config.magnifier_enabled，main() 里覆盖
let copiedAt = 0; // 最近一次复制色值的时间戳

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

// 工具栏
// ============================================================
const toolbarUi = createToolbar({
  uiLayer,
  color: editorSession.color,
  strokeWidth: editorSession.strokeWidth,
  getTool: () => editorSession.tool,
  onToolChange: setTool,
  onOcr: () => void runOcr(),
  onReselect: () => {
    editorSession.selection = null;
    editorSession.selectedIndex = null;
    setTool(null);
    render();
  },
  onCancel: () => void closeScreenshot(),
  onExport: (action) => void exportImage(action),
  onColorChange: (next) => {
    editorSession.color = next;
    toolbarUi.syncColor(editorSession.color);
  },
  onStrokeWidthChange: (next) => {
    editorSession.strokeWidth = next;
    toolbarUi.syncStrokeWidth(editorSession.strokeWidth);
  },
});
const { toolbar, toolBtns } = toolbarUi;

function closePopups() {
  editorUi.closePopups();
}

function setTool(t: Tool | null) {
  editorSession.tool = t;
  for (const [k, button] of toolBtns) button.classList.toggle("active", k === t);
  if (t !== null) {
    editorSession.selectedIndex = null;
    closePopups();
  }
  render();
}

// ---------- 文本输入 ----------
const textInputUi = createTextInputController({
  uiLayer,
  root,
  context: ctx,
  getCanvasSize: () => ({ width: totalW, height: totalH }),
  getStyle: () => ({ color: editorSession.color, strokeWidth: editorSession.strokeWidth }),
  getScale: physScale,
  onCommit: (shape) => {
    editorSession.checkpoint();
    editorSession.shapes.push(shape);
  },
  onRender: render,
});
const textInput = textInputUi.element;

// 帮助框
// ============================================================
const helpPanel = createHelpPanel(uiLayer);
const helpBox = helpPanel.element;

function updateHelpBox() {
  editorUi.updateHelp();
}
/** 截图窗打开瞬间的鼠标位置。初始时还没有 mousemove，也要把提示放在当前屏。 */
let initialCursorPos: Pt | null = null;

// ---------- OCR 结果面板 ----------
const ocrUi = createOcrPanel(uiLayer, (text) => {
  if (text) void copyText(text);
});
const ocrPanel = ocrUi.element;
editorUi = createEditorUiController({
  root,
  toolbarUi,
  helpPanel,
  ocrUi,
  getSelection: () => editorSession.selection,
  getAnchor: () => editorInput?.getFrameState().lastMousePos ?? initialCursorPos,
  toCssBox,
  rootBox: rootBoxCss,
  monitorBox: monitorBoxCss,
  getColor: () => editorSession.color,
  getCopyColorHotkey: () => copyColorHotkey,
  getMagnifierActive: () => magnifierActive,
});
function showOcrPanel(text: string, isError = false) {
  editorUi.showOcr(text, isError);
}

// ============================================================
// 几何工具
// ============================================================
function hitTestShapes(p: Pt): number | null {
  for (let i = editorSession.shapes.length - 1; i >= 0; i--) {
    if (isShapeHit(editorSession.shapes[i], p, 8 * physScale())) return i;
  }
  return null;
}

function hitHandle(p: Pt): { index: number; handle: number } | null {
  if (editorSession.selectedIndex == null) return null;
  const s = editorSession.shapes[editorSession.selectedIndex];
  if (!s) return null;
  const handles = shapeHandles(s);
  for (let i = 0; i < handles.length; i++) {
    if (Math.hypot(p.x - handles[i].x, p.y - handles[i].y) <= HANDLE_HIT) {
      return { index: editorSession.selectedIndex, handle: i };
    }
  }
  return null;
}

// ============================================================
// 绘制
// ============================================================
// 从多屏截图采样一块区域，绘制到目标矩形（用于马赛克/放大镜/导出/OCR）。
// 坐标系约定：src 侧（sx, sy）与 screens[] 一律是 **root-local 物理像素**；
// dst 侧（dx, dy, dw, dh）是目标 canvas 的坐标。两侧各自独立，不混用。
function screenSources() {
  return screens.map(({ img, x, y, w, h }) => ({ image: img, x, y, w, h }));
}

const magnifier = createMagnifierRenderer({
  getScreens: screenSources,
  getViewport: () => root.getBoundingClientRect(),
  getScale: physScale,
  translate: t,
  getCopyColorHotkey: () => copyColorHotkey,
  getCopiedAt: () => copiedAt,
});
const drawMagnifier = magnifier.draw;
const editorRenderer = createEditorCanvasRenderer({
  context: ctx,
  getScreens: screenSources,
  getScale: physScale,
  mosaicWidth,
  drawMagnifier,
});

screenshotActions = createScreenshotActionController({
  getSelection: () => editorSession.selection,
  getScreens: screenSources,
  getShapes: () => editorSession.shapes,
  drawShape: editorRenderer.drawShape,
  translate: t,
  showOcr: showOcrPanel,
});

function render() {
  // 滚动截图进行中/已完成：只画「压暗 + 选区挖空 + 外框」，不画底图/标注/工具栏。
  // 选区挖空是硬要求——后端按屏幕像素捕获，覆盖窗在选区里必须完全透明。
  if (scrollActive()) {
    renderScrollOverlay();
    scrollPositioner.position();
    return;
  }

  const input = editorInput?.getFrameState();
  const selRect =
    input?.dragMode === "select" && input.dragStart && input.dragCur
      ? normRect(input.dragStart, input.dragCur)
      : editorSession.selection;
  editorRenderer.render({
    canvas,
    selection: selRect,
    shapes: editorSession.shapes,
    currentShape: editorSession.currentShape,
    selectedIndex: editorSession.selectedIndex,
    // 滚动截图（包括待框选阶段）不需要取色；普通截图则允许放大镜跨过工具栏、
    // 提示框等浮层继续跟随鼠标。画布在 UI 层下方，因此不会遮挡这些控件。
    magnifierPoint:
      magnifierActive && scroll.phase === "idle" && input?.lastMousePos ? input.lastMousePos : null,
    windowHover:
      input?.hoverWin &&
      !editorSession.selection &&
      !editorSession.tool &&
      (input.dragMode === "none" || input.dragMode === "pending-win")
        ? input.hoverWin
        : null,
  });

  editorUi.sync();

  // 滚动截图「待开始」态：选区一确定就把开始面板摆出来（拖拽过程中也跟着刷新）
  if (scroll.phase === "armed") syncScrollUi();
}

// ============================================================
// 历史
// ============================================================
function undo() {
  if (editorSession.undo()) render();
}

function redo() {
  if (editorSession.redo()) render();
}

// ============================================================
// 鼠标交互
// ============================================================
// ---------- 文本输入 ----------

// Pointer interaction is deliberately isolated from the composition root.
editorInput = createEditorInputController({
  root,
  canvas,
  getBounds: () => ({ totalW, totalH, minX, minY }),
  getScreens: () => screens,
  getSelection: () => editorSession.selection,
  setSelection: (next) => {
    editorSession.selection = next;
  },
  getTool: () => editorSession.tool,
  getStyle: () => ({
    color: editorSession.color,
    strokeWidth: editorSession.strokeWidth,
    mosaicWidth,
  }),
  getShapes: () => editorSession.shapes,
  getSelectedIndex: () => editorSession.selectedIndex,
  setSelectedIndex: (next) => {
    editorSession.selectedIndex = next;
  },
  getCurrentShape: () => editorSession.currentShape,
  setCurrentShape: (next) => {
    editorSession.currentShape = next;
  },
  isTextEditing: () => textInput.classList.contains("editing"),
  showTextInput: (point) => textInputUi.show(point),
  isScrollActive: scrollActive,
  hitTestShapes,
  hitHandle,
  pickWindowAt,
  minShapeSize: MIN_SHAPE_SIZE,
  onCheckpoint: (snapshot) => editorSession.checkpoint(snapshot),
  render,
});

// ============================================================
// 键盘
// ============================================================

// 取色热键（读 config.hotkeys.copy_color，main() 里覆盖；与后端默认一致）
let copyColorHotkey = "Alt+C";

bindEditorShortcuts({
  isTextEditing: () => textInput.classList.contains("editing"),
  getScrollPhase: () => scroll.phase,
  getSelection: () => editorSession.selection,
  onStopScroll: stopScrollCaptureNow,
  onDiscardAndClose: () => {
    void discardScrollCapture();
    void closeScreenshot();
  },
  onFinishScroll: () => void finishScrollAction("clipboard"),
  onExitScroll: exitScrollMode,
  onStartScroll: () => void beginScrollCapture(),
  onClose: () => void closeScreenshot(),
  onExport: (action) => void exportImage(action),
  getCopyColorHotkey: () => copyColorHotkey,
  getColorPoint: () => {
    const input = editorInput.getFrameState();
    return magnifierActive && scroll.phase === "idle" ? input.lastMousePos : null;
  },
  onCopyColor: (point) => {
    const hex = magnifier.colorAt(point.x, point.y);
    if (!hex) return;
    void copyText(hex);
    copiedAt = performance.now();
    render();
  },
  onUndo: undo,
  onRedo: redo,
  onDelete: () => {
    if (editorSession.deleteSelected()) render();
  },
});

// 阻止浏览器默认右键菜单
window.addEventListener("contextmenu", (e) => e.preventDefault());

// ============================================================
// 导出
// ============================================================
async function exportImage(action: "save" | "clipboard") {
  await screenshotActions.exportImage(action);
}

// ============================================================
// OCR
// ============================================================
async function runOcr() {
  await screenshotActions.runOcr();
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

const scrollSession = createScrollCaptureSession();
const scroll = scrollSession.state;

function scrollActive(): boolean {
  return scroll.phase === "capturing" || scroll.phase === "done";
}

// ---------- 开始面板 ----------
const scrollPanelUi = createScrollCaptureStartPanel({
  uiLayer,
  onStart: () => void beginScrollCapture(),
  onQuit: exitScrollMode,
  onModeChange: syncScrollUi,
});
const { panel: scrollPanel, manual: shManual } = scrollPanelUi;

// 自动滚动时，选区边缘显示绿色聚焦光晕；HUD 负责进度、结果和操作按钮。
const scrollHudUi = createScrollCaptureHud({
  uiLayer,
  onStop: () => stopScrollCaptureNow(),
  onAction: (action) => void finishScrollAction(action),
  onLayout: () => scrollPositioner?.position(),
});
const { selectionGlow: scrollSelectionGlow, hud: scrollHud, notice: scrollNotice } = scrollHudUi;

scrollPositioner = createScrollCapturePositioner({
  getSelection: () => editorSession.selection,
  getCaptureRect: () => scroll.captureRect,
  toCssBox,
  rootBox: rootBoxCss,
  monitorBox: monitorBoxCss,
  panel: scrollPanel,
  hud: scrollHud,
  notice: scrollNotice,
  glow: scrollSelectionGlow,
  onHudOverlap: (next) => {
    scroll.hudOverlap = next;
  },
});

scrollController = createScrollCaptureController({
  session: scrollSession,
  panel: scrollPanelUi,
  hud: scrollHudUi,
  root,
  toolbar,
  helpBox,
  clearOcr: ctx0ClearOcr,
  closePopups,
  getSelection: () => editorSession.selection,
  getBounds: () => ({ minX, minY }),
  translate: t,
  render,
  position: () => scrollPositioner.position(),
  showNotice: showScrollNotice,
  closeScreenshot,
});

screenshotLoadController = createScreenshotLoadController({
  root,
  canvas,
  resetSession: resetScreenshotSession,
  setBounds: (bounds) => {
    totalW = bounds.totalW;
    totalH = bounds.totalH;
    minX = bounds.minX;
    minY = bounds.minY;
  },
  setInitialCursor: (cursor) => {
    initialCursorPos = cursor;
  },
  setScreens: (next) => {
    screens = next;
  },
  render,
  restoreRunningScrollSession,
  logLoaded: logScreenshotLoaded,
});

/** 进入「待框选」态：清空选区与工具，让用户重新拉框 */
function enterScrollArm() {
  scrollSession.arm();
  editorSession.selection = null;
  editorSession.selectedIndex = null;
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
  scrollSession.reset();
  scrollSelectionGlow.classList.remove("capture-hidden");
  syncScrollUi();
  void closeScreenshot();
}

// 由开始面板（或 armed 态的 Enter）明确启动，避免用户来不及选择自动/手动模式。
async function beginScrollCapture() {
  await scrollController.begin();
}

function stopScrollCaptureNow() {
  scrollController.stop();
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
  await scrollController.finish(action);
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
  scrollPositioner.positionNotice();
  if (scrollNoticeTimer !== undefined) window.clearTimeout(scrollNoticeTimer);
  scrollNoticeTimer = window.setTimeout(
    () => scrollNotice.classList.remove("on"),
    isError ? 6000 : 2200,
  );
}

function syncScrollUi() {
  scrollController.syncUi();
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

/**
 * 捕获/完成态的画布：整屏压暗 → **挖空选区**（透明，透出真实窗口）→ 选区外框。
 * 采集进行中绝不绘制边框：即使它理论上压在捕获区外，混合 DPI/整屏选区的边界
 * 取整仍可能让一像素绿线被 BitBlt 带进结果。
 */
function renderScrollOverlay() {
  renderScrollCaptureOverlay({
    context: ctx,
    canvas,
    selection: editorSession.selection,
    captureRect: scroll.captureRect,
    phase: scroll.phase,
    progress: scroll.progress,
    error: scroll.error,
    scale: physScale(),
  });
}

/** OCR 面板在滚动模式里要让位（否则会压在选区上/干扰视线） */
function ctx0ClearOcr() {
  ocrPanel.style.display = "none";
}

// ============================================================
// 事件绑定 + 初始化
// ============================================================
canvas.addEventListener("mousedown", editorInput.onMouseDown);
window.addEventListener("mousemove", editorInput.onMouseMove);
window.addEventListener("mouseup", editorInput.onMouseUp);

function resetScreenshotSession() {
  root.querySelectorAll(":scope > img").forEach((element) => {
    element.remove();
  });
  editorSession.reset();
  for (const button of toolBtns.values()) button.classList.toggle("active", false);
  textInput.classList.remove("editing");
  ocrPanel.style.display = "none";
  screens = [];
  editorInput.reset();
  scrollSession.reset();
  shManual.checked = false;
  void discardScrollCapture();
  syncScrollUi();
}

function logScreenshotLoaded(data: {
  min_x: number;
  min_y: number;
  total_width: number;
  total_height: number;
  screens: unknown[];
  monitor_info: unknown;
}) {
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
  const viewport = root.getBoundingClientRect();
  console.info(
    "[screenshot] viewport:",
    JSON.stringify({
      totalW,
      totalH,
      minX: data.min_x,
      minY: data.min_y,
      rootW: +viewport.width.toFixed(1),
      rootH: +viewport.height.toFixed(1),
      rootLeft: +viewport.left.toFixed(1),
      rootTop: +viewport.top.toFixed(1),
      dpr: window.devicePixelRatio,
      physScale: +physScale().toFixed(4),
      canvasAttr: `${canvas.width}x${canvas.height}`,
      canvasCss: `${+canvas.getBoundingClientRect().width.toFixed(1)}x${+canvas.getBoundingClientRect().height.toFixed(1)}`,
      monitors: data.monitor_info,
    }),
  );
}

async function loadScreenshot() {
  await screenshotLoadController.load();
}

/** 后端会话仍在跑时，把前端切回捕获态并拉一次最新进度（事件之外的兜底查询）。
 *
 *  这同时是 `scroll_capture_progress` 这条命令存在的意义：进度事件在窗口关闭期间
 *  是**丢失**的，只有主动拉取才能把 HUD 立刻填上正确数字。 */
async function restoreRunningScrollSession() {
  try {
    if (!(await scrollCaptureRunning())) return;
    scrollSession.restore(await scrollCaptureProgress(), minX, minY);
    syncScrollUi();
    render();
  } catch {
    // 查不到就按普通截图处理，不影响主流程
  }
}

async function refreshConfig() {
  await refreshScreenshotConfig({
    setMagnifierEnabled: (enabled) => {
      magnifierActive = enabled;
    },
    setLanguage: setLang,
    setCopyColorHotkey: (hotkey) => {
      copyColorHotkey = hotkey;
    },
    applyTheme,
    applyI18n: () => applyI18n(document),
    updateHelp: updateHelpBox,
  });
}

// 截图窗口 UI 主题：与主窗口一致，跟随 config.theme（dark / light / system），
// 由 screenshot.html 里 :root[data-theme] 变量驱动工具栏/弹窗/帮助框/OCR 面板配色。
function applyTheme(theme: "dark" | "light" | "system") {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function clearScreenshotState() {
  resetScreenshotSession();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  document.body.classList.remove("ready");
}

function handleScrollProgress(progress: ScrollCaptureProgress) {
  scrollSession.receiveProgress(progress, minX, minY);
  syncScrollUi();
  render();
}

function handleScrollHud({
  hidden,
  hud,
  glow,
}: {
  hidden: boolean;
  hud?: boolean;
  glow?: boolean;
}) {
  if (hud !== false && scrollSession.receiveHudVisibility(!!hidden, true)) {
    scrollHud.classList.toggle("hud-hidden", !!hidden);
  }
  if (glow) scrollSelectionGlow.classList.toggle("capture-hidden", !!hidden);
}

function handleScrollDone(done: ScrollCaptureDone) {
  scrollSession.receiveDone(done, performance.now());
  scrollHud.classList.remove("hud-hidden", "clickthrough");
  scrollSelectionGlow.classList.remove("capture-hidden");
  syncScrollUi();
  render();
}

async function main() {
  await startScreenshotLifecycle({
    refreshConfig,
    loadScreenshot,
    clearScreenshot: clearScreenshotState,
    applyScrollStartMode,
    onScrollProgress: handleScrollProgress,
    onScrollHud: handleScrollHud,
    onScrollDone: handleScrollDone,
  });
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

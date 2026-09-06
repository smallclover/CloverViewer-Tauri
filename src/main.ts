import "./styles.css";
import { applyI18n, setLang, t, type Lang } from "./i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppConfig,
  ImageEntry,
  fileSrc,
  formatDimensions,
  formatSize,
  getConfig,
  getImageInfo,
  getThumbnail,
  listImages,
  readImageData,
  setConfig,
  setLaunchOnStartup,
  setShowScreenshotHotkey,
} from "./api";

// ---------- 状态 ----------
let config: AppConfig | null = null;
let currentDir = "";
let images: ImageEntry[] = [];
let activeIndex = -1; // 当前单图索引
let viewMode: "grid" | "single" = "grid";
let propsVisible = true; // 属性栏开关（仅在单图视图可用）

// 单图缩放/平移/旋转/翻转
let scale = 1;
let fitMode = true;
const pan = { x: 0, y: 0 };
let rotation = 0; // 0/90/180/270
let flipH = false;
let flipV = false;

// 非 WebView 友好格式的解码缓存（path -> dataURL）
const decodedCache = new Map<string, string>();

// 属性面板渲染 token（防止快速切换时旧 EXIF 异步结果串台）
let propsToken = 0;

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const emptyState = $("empty-state");
const gridView = $("grid-view");
const grid = $("grid");
const gridSpacer = $("grid-spacer");
const singleView = $("single-view");
const imgStage = $("img-stage");
const singleImg = $<HTMLImageElement>("single-img");
const propsList = $("props-list");
const propsPanel = $("props-panel");
const breadcrumb = $("breadcrumb");
const statusLeft = $("status-left");
const statusRight = $("status-right");
const btnProps = $("btn-props");
const btnRotate = $("btn-rotate");
const btnFlipH = $("btn-flip-h");
const btnFlipV = $("btn-flip-v");
const btnGrid = $<HTMLButtonElement>("btn-grid");
const btnSingle = $<HTMLButtonElement>("btn-single");
const dropOverlay = $("drop-overlay");
const toastEl = $("toast");
const ctxMenu = $("context-menu");

// ---------- 工具 ----------
let toastTimer: number | undefined;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove("show");
    toastEl.classList.add("hidden");
  }, 2200);
}

async function srcFor(entry: ImageEntry): Promise<string> {
  if (entry.web_supported) return fileSrc(entry.path);
  const cached = decodedCache.get(entry.path);
  if (cached) return cached;
  const dataUrl = await readImageData(entry.path);
  decodedCache.set(entry.path, dataUrl);
  if (decodedCache.size > 20) {
    // 简单限制缓存规模
    const first = decodedCache.keys().next().value;
    if (first) decodedCache.delete(first);
  }
  return dataUrl;
}

// ---------- 主题 ----------
function applyTheme(theme: "dark" | "light" | "system") {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

// ---------- 面包屑 ----------
function renderBreadcrumb() {
  breadcrumb.innerHTML = "";
  if (!currentDir) return;
  const parts = currentDir.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "›";
      breadcrumb.appendChild(sep);
    }
    const crumb = document.createElement("span");
    crumb.className = "crumb";
    crumb.textContent = part;
    crumb.addEventListener("click", () => {
      const target = parts.slice(0, i + 1).join("/");
      const path = /^[a-z]:$/i.test(parts[0]) ? target : `//${target}`;
      void openDirectory(path);
    });
    breadcrumb.appendChild(crumb);
  });
}

// ---------- 目录加载 ----------
async function openDirectory(dir: string) {
  try {
    const entries = await listImages(dir);
    images = entries;
    currentDir = dir;
    decodedCache.clear();
    renderBreadcrumb();
    if (entries.length === 0) {
      toast(t("toast.noImages"));
    }
    activeIndex = -1;
    showGrid();
    refreshStatus();
  } catch (e) {
    toast(t("toast.openFailed", { msg: String(e) }));
  }
}

async function openFileOrFolder(path: string) {
  // 拖入的可能是文件（取其所在目录）或目录
  const normalized = path.replace(/\\/g, "/");
  const isFile = /\.(png|jpe?g|bmp|gif|webp|tiff?|avif)$/i.test(normalized);
  if (!isFile) {
    await openDirectory(normalized);
    return;
  }
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return;
  const dir = normalized.slice(0, lastSlash);
  const fileName = normalized.slice(lastSlash + 1);
  await openDirectory(dir);
  const idx = images.findIndex((img) => img.name === fileName);
  if (idx >= 0) showSingle(idx);
}

// ---------- 视图切换（右下角两键并存） ----------
function updateViewSwitch() {
  const single = viewMode === "single";
  btnGrid.classList.toggle("active", !single);
  btnSingle.classList.toggle("active", single);
  btnSingle.disabled = images.length === 0;
}

// 单图专属工具栏按钮（旋转/翻转）显隐
function setImageToolsVisible(v: boolean) {
  btnRotate.classList.toggle("hidden", !v);
  btnFlipH.classList.toggle("hidden", !v);
  btnFlipV.classList.toggle("hidden", !v);
}

// ---------- 网格视图（窗口化虚拟滚动） ----------
const CELL_W = 160;
const CELL_H = 154; // thumb 120 + label 30 + border 2*2
const GAP = 10;
const BUFFER_ROWS = 2;
let cols = 4;
let leftPad = 0;
const renderedCells = new Map<number, HTMLElement>();
let scrollRaf = 0;

function computeLayout() {
  const w = gridView.clientWidth - 20; // 减去 padding 10*2
  cols = Math.max(1, Math.floor((w + GAP) / (CELL_W + GAP)));
  const contentW = cols * CELL_W + (cols - 1) * GAP;
  leftPad = Math.max(0, (w - contentW) / 2);
}

function totalHeight(): number {
  const rows = Math.ceil(images.length / cols);
  return rows * CELL_H + (rows - 1) * GAP;
}

function thumbSize(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(384, Math.max(160, Math.round(CELL_W * dpr)));
}

function showGrid() {
  viewMode = "grid";
  emptyState.classList.toggle("hidden", images.length > 0 || !!currentDir);
  gridView.classList.toggle("hidden", images.length === 0);
  singleView.classList.add("hidden");
  btnProps.classList.add("hidden");
  setImageToolsVisible(false);
  updateViewSwitch();
  renderGrid();
}

function renderGrid() {
  computeLayout();
  gridSpacer.style.height = `${totalHeight()}px`;
  for (const [, el] of renderedCells) el.remove();
  renderedCells.clear();
  renderVisible();
}

function renderVisible() {
  const scrollTop = gridView.scrollTop;
  const viewH = gridView.clientHeight;
  const firstRow = Math.floor(scrollTop / (CELL_H + GAP));
  const lastRow = Math.ceil((scrollTop + viewH) / (CELL_H + GAP));
  const from = Math.max(0, (firstRow - BUFFER_ROWS) * cols);
  const to = Math.min(images.length, (lastRow + BUFFER_ROWS) * cols);

  const needed = new Set<number>();
  for (let i = from; i < to; i++) needed.add(i);

  for (const [idx, el] of renderedCells) {
    if (!needed.has(idx)) {
      el.remove();
      renderedCells.delete(idx);
    }
  }
  for (let i = from; i < to; i++) {
    if (!renderedCells.has(i)) {
      const el = createCell(i);
      renderedCells.set(i, el);
      grid.appendChild(el);
    }
  }
}

function createCell(i: number): HTMLElement {
  const entry = images[i];
  const cell = document.createElement("div");
  cell.className = "cell" + (i === activeIndex ? " active" : "");
  cell.dataset.index = String(i);
  const col = i % cols;
  const row = Math.floor(i / cols);
  cell.style.left = `${leftPad + col * (CELL_W + GAP)}px`;
  cell.style.top = `${row * (CELL_H + GAP)}px`;
  cell.style.width = `${CELL_W}px`;

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const img = document.createElement("img");
  img.alt = entry.name;
  img.draggable = false;
  thumb.appendChild(img);
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = entry.name;
  cell.appendChild(thumb);
  cell.appendChild(label);

  cell.addEventListener("click", () => showSingle(i));

  // 缩略图：Rust 缩略图优先，失败回退原图
  getThumbnail(entry.path, thumbSize())
    .then((dataUrl) => {
      img.src = dataUrl;
    })
    .catch(() => {
      void srcFor(entry).then((s) => {
        img.src = s;
      });
    });

  return cell;
}

function updateCellActive() {
  for (const [idx, el] of renderedCells) {
    el.classList.toggle("active", idx === activeIndex);
  }
}

gridView.addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    renderVisible();
  });
});

// ---------- 属性栏开关 ----------
function toggleProps() {
  propsVisible = !propsVisible;
  applyPropsState();
}

function applyPropsState() {
  btnProps.classList.toggle("active", propsVisible);
  propsPanel.classList.toggle("collapsed", !propsVisible);
  if (viewMode === "single") applyTransform(); // 面板显隐改变可视区域，重算适应/平移
}

// ---------- 单图视图 ----------
function showSingle(index: number) {
  if (index < 0 || index >= images.length) return;
  activeIndex = index;
  viewMode = "single";
  emptyState.classList.add("hidden");
  gridView.classList.add("hidden");
  singleView.classList.remove("hidden");
  btnProps.classList.remove("hidden");
  setImageToolsVisible(true);
  updateViewSwitch();
  updateCellActive();
  applyPropsState();

  const entry = images[index];
  fitMode = true;
  scale = 1;
  rotation = 0;
  flipH = false;
  flipV = false;
  pan.x = 0;
  pan.y = 0;
  applyTransform();
  void srcFor(entry).then((src) => {
    singleImg.src = src;
  });
  renderProps(entry);
  refreshStatus();
  preloadNeighbors(index);
}

// 刷新状态栏文案（语言切换时也会调用）
function refreshStatus() {
  if (viewMode === "single" && activeIndex >= 0 && images[activeIndex]) {
    const entry = images[activeIndex];
    statusLeft.textContent = entry.name;
    statusRight.textContent = `${activeIndex + 1} / ${images.length} · ${formatDimensions(entry.width, entry.height)}`;
  } else if (currentDir) {
    statusLeft.textContent =
      images.length > 0 ? currentDir : `${currentDir}${t("status.noImages")}`;
    statusRight.textContent = t("status.imageCount", { count: images.length });
  } else {
    statusLeft.textContent = t("status.ready");
    statusRight.textContent = "";
  }
}

// 预加载相邻图片（原图，浏览器缓存）
function preloadNeighbors(index: number) {
  for (const off of [-1, 1]) {
    const i = index + off;
    if (i < 0 || i >= images.length) continue;
    const entry = images[i];
    if (entry.web_supported) {
      const img = new Image();
      img.src = fileSrc(entry.path);
    }
  }
}

function appendPropRow(k: string, v: string) {
  const row = document.createElement("div");
  row.className = "prop-row";
  const label = document.createElement("div");
  label.className = "prop-label";
  label.textContent = k;
  const value = document.createElement("div");
  value.className = "prop-value";
  value.textContent = v;
  value.title = v; // 过长时悬停可看全文
  row.appendChild(label);
  row.appendChild(value);
  propsList.appendChild(row);
}

function renderProps(entry: ImageEntry) {
  const token = ++propsToken;
  propsList.innerHTML = "";

  const mtime = entry.modified ? new Date(entry.modified).toLocaleString() : "—";
  const rows: [string, string][] = [
    [t("prop.filename"), entry.name],
    [t("prop.path"), entry.path],
    [t("prop.dimensions"), formatDimensions(entry.width, entry.height)],
    [t("prop.size"), formatSize(entry.size)],
    [t("prop.modified"), mtime],
    [t("prop.format"), entry.path.split(".").pop()?.toUpperCase() ?? "—"],
  ];
  for (const [k, v] of rows) appendPropRow(k, v);

  // 异步补 EXIF 字段（token 防快速切换时串台）
  void getImageInfo(entry.path)
    .then((info) => {
      if (token !== propsToken) return;
      const exifRows: [string, string][] = [
        [t("prop.datetime"), info.datetime],
        [t("prop.camera"), [info.make, info.model].filter(Boolean).join(" ")],
        [t("prop.iso"), info.iso],
        [t("prop.aperture"), info.f_number],
        [t("prop.shutter"), info.exposure_time],
        [t("prop.focal"), info.focal_length],
        [t("prop.lens"), info.lens_model],
      ];
      for (const [k, v] of exifRows) {
        if (v) appendPropRow(k, v);
      }
    })
    .catch(() => {});
}

function fitScale(): number {
  const rect = imgStage.getBoundingClientRect();
  const img = singleImg;
  if (!img.naturalWidth || !rect.width) return 1;
  const swapped = rotation % 180 !== 0;
  const w = swapped ? img.naturalHeight : img.naturalWidth;
  const h = swapped ? img.naturalWidth : img.naturalHeight;
  return Math.min(rect.width / w, rect.height / h);
}

function applyTransform() {
  const flip = `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`;
  let base: string;
  if (fitMode) {
    const s = fitScale();
    base = `translate(-50%, -50%) scale(${s})`;
  } else {
    base = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${scale})`;
  }
  singleImg.style.transform = `${base} rotate(${rotation}deg) ${flip}`;
}

singleImg.addEventListener("load", () => applyTransform());
window.addEventListener("resize", () => {
  if (viewMode === "single") applyTransform();
  else if (viewMode === "grid" && images.length > 0) renderGrid();
});

// 滚轮缩放
imgStage.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (fitMode) {
    // 以鼠标为中心进入自由缩放
    fitMode = false;
    pan.x = 0;
    pan.y = 0;
    scale = fitScale();
  }
  const sens = config?.zoom_sensitivity ?? 1;
  const factor = Math.exp(-e.deltaY * 0.0015 * sens);
  const rect = imgStage.getBoundingClientRect();
  const cx = e.clientX - rect.left - rect.width / 2;
  const cy = e.clientY - rect.top - rect.height / 2;
  const newScale = Math.min(Math.max(scale * factor, 0.05), 40);
  const k = newScale / scale;
  // 缩放时保持鼠标下的图像点不动
  pan.x = cx - k * (cx - pan.x);
  pan.y = cy - k * (cy - pan.y);
  scale = newScale;
  applyTransform();
});

// 拖拽平移
let dragging = false;
let dragStart = { x: 0, y: 0 };
imgStage.addEventListener("mousedown", (e) => {
  if (viewMode !== "single") return;
  if (fitMode) return; // 适应模式下拖动无意义
  dragging = true;
  dragStart = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  imgStage.classList.add("panning");
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  pan.x = e.clientX - dragStart.x;
  pan.y = e.clientY - dragStart.y;
  applyTransform();
});
window.addEventListener("mouseup", () => {
  dragging = false;
  imgStage.classList.remove("panning");
});

// 双击：适应 ↔ 100%
imgStage.addEventListener("dblclick", () => {
  if (fitMode) {
    fitMode = false;
    scale = 1;
    pan.x = 0;
    pan.y = 0;
  } else {
    fitMode = true;
  }
  applyTransform();
});

// 旋转/翻转
function rotateImage() {
  rotation = (rotation + 90) % 360;
  applyTransform();
}
function flipHorizontal() {
  flipH = !flipH;
  applyTransform();
}
function flipVertical() {
  flipV = !flipV;
  applyTransform();
}

// ---------- 导航 ----------
function navigate(delta: number) {
  if (images.length === 0) return;
  const next = (activeIndex + delta + images.length) % images.length;
  showSingle(next);
}

// ---------- 键盘 ----------
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    void pickFolder();
    return;
  }
  switch (e.key) {
    case "ArrowLeft":
      if (viewMode === "single") navigate(-1);
      break;
    case "ArrowRight":
      if (viewMode === "single") navigate(1);
      break;
    case "Escape":
      if (viewMode === "single") showGrid();
      break;
    case "Tab":
      e.preventDefault();
      if (viewMode === "single") showGrid();
      else if (images.length > 0) showSingle(Math.max(activeIndex, 0));
      break;
    case "0":
      if (viewMode === "single") {
        fitMode = true;
        applyTransform();
      }
      break;
    case "1":
      if (viewMode === "single") {
        fitMode = false;
        scale = 1;
        pan.x = 0;
        pan.y = 0;
        applyTransform();
      }
      break;
    case "r":
    case "R":
      if (viewMode === "single") rotateImage();
      break;
    case "h":
    case "H":
      if (viewMode === "single") flipHorizontal();
      break;
    case "v":
    case "V":
      if (viewMode === "single") flipVertical();
      break;
  }
});

// ---------- 文件夹选择 ----------
async function pickFolder() {
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected === "string") {
    await openDirectory(selected);
  }
}

// ---------- 事件绑定 ----------
$("btn-open").addEventListener("click", () => void pickFolder());
btnGrid.addEventListener("click", showGrid);
btnSingle.addEventListener("click", () => {
  if (images.length === 0) {
    toast(t("toast.noImagesOpenFirst"));
    return;
  }
  showSingle(Math.max(activeIndex, 0));
});
btnProps.addEventListener("click", toggleProps);
btnRotate.addEventListener("click", rotateImage);
btnFlipH.addEventListener("click", flipHorizontal);
btnFlipV.addEventListener("click", flipVertical);
updateViewSwitch(); // 初始状态：网格高亮；无图时禁用单图

// ---------- 无边框窗口控制 ----------
const win = getCurrentWindow();
$("win-min").addEventListener("click", () => void win.minimize());
// close() 会触发 CloseRequested：若开启“关闭最小化到托盘”则隐藏到托盘，
// 否则真正退出——与原有行为一致。
$("win-close").addEventListener("click", () => void win.close());
// ---------- 无边框窗口：标题栏拖动 + 边缘缩放（原生） ----------
// 使用 Tauri 原生 startDragging / startResizeDragging，由操作系统接管拖动/缩放
// 循环。手写 setPosition + setSize 在每帧 mousemove 里挪动窗口时，WebView2 的
// 合成器跟不上窗口位置，导致「拖动时闪动、重影」。原生拖拽让窗口与内容原子移动，
// 不会出现该问题。
const titlebar = $("titlebar");

titlebar.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest(".titlebar-controls")) return;
  void win.startDragging();
});

// 边缘缩放：原生 startResizeDragging 按方向交给系统处理
const resizeHandles = document.querySelectorAll<HTMLElement>(".resize-handle");
resizeHandles.forEach((h) => {
  h.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const dir = h.dataset.dir;
    if (
      dir === "East" || dir === "West" || dir === "South" ||
      dir === "SouthEast" || dir === "SouthWest"
    ) {
      void win.startResizeDragging(dir);
    }
  });
});

// ---------- 自定义右键菜单（接管 WebView 默认菜单） ----------
type CtxItem = { label: string; action: () => void } | "sep";

function showContextMenu(x: number, y: number, items: CtxItem[]) {
  ctxMenu.innerHTML = "";
  for (const it of items) {
    if (it === "sep") {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      ctxMenu.appendChild(sep);
      continue;
    }
    const el = document.createElement("div");
    el.className = "ctx-item";
    el.textContent = it.label;
    el.addEventListener("click", () => {
      hideContextMenu();
      it.action();
    });
    ctxMenu.appendChild(el);
  }
  ctxMenu.classList.remove("hidden");
  // 先显示再测量，clamp 到视口内
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 6))}px`;
  ctxMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 6))}px`;
}

function hideContextMenu() {
  ctxMenu.classList.add("hidden");
}

// 复制位图：统一经 canvas 转 PNG 写入剪贴板（兼容 JPG/TIFF 等非 PNG 源）
async function copyImageBitmap(entry: ImageEntry) {
  try {
    const src = await srcFor(entry);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Image load failed"));
      img.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("PNG encoding failed");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast(t("toast.copiedImage"));
  } catch (e) {
    toast(t("toast.copyFailed", { msg: String(e) }));
  }
}

async function copyImagePath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    toast(t("toast.copiedPath"));
  } catch (e) {
    toast(t("toast.copyFailed", { msg: String(e) }));
  }
}

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const cell = (e.target as HTMLElement).closest(".cell");
  if (cell && grid.contains(cell)) {
    const idx = Number((cell as HTMLElement).dataset.index);
    const entry = images[idx];
    if (!entry) return;
    showContextMenu(e.clientX, e.clientY, [
      { label: t("ctx.view"), action: () => showSingle(idx) },
      "sep",
      { label: t("ctx.copyImage"), action: () => void copyImageBitmap(entry) },
      { label: t("ctx.copyPath"), action: () => void copyImagePath(entry.path) },
    ]);
    return;
  }
  if (viewMode === "single" && imgStage.contains(e.target as Node)) {
    const entry = images[activeIndex];
    if (!entry) return;
    showContextMenu(e.clientX, e.clientY, [
      { label: t("ctx.copyImage"), action: () => void copyImageBitmap(entry) },
      { label: t("ctx.copyPath"), action: () => void copyImagePath(entry.path) },
    ]);
    return;
  }
  hideContextMenu();
});

window.addEventListener("mousedown", (e) => {
  if (!ctxMenu.contains(e.target as Node)) hideContextMenu();
});
window.addEventListener("blur", hideContextMenu);

// 拖放打开
void getCurrentWindow().onDragDropEvent((event) => {
  const payload = event.payload;
  if (payload.type === "enter" || payload.type === "over") {
    dropOverlay.classList.remove("hidden");
  } else {
    dropOverlay.classList.add("hidden");
    if (payload.type === "drop" && payload.paths.length > 0) {
      void openFileOrFolder(payload.paths[0]);
    }
  }
});

// ---------- 设置面板 ----------
const settingsOverlay = $("settings-overlay");
const setLanguage = $<HTMLSelectElement>("set-language");
const setTheme = $<HTMLSelectElement>("set-theme");
const setZoom = $<HTMLInputElement>("set-zoom");
const setZoomVal = $("set-zoom-val");
const setHotkey = $<HTMLInputElement>("set-hotkey");
const setColorHotkey = $<HTMLInputElement>("set-color-hotkey");
const setMagnifier = $<HTMLInputElement>("set-magnifier");
const setMinimize = $<HTMLInputElement>("set-minimize");
const setAutostart = $<HTMLInputElement>("set-autostart");

function saveSettings(partial: Partial<AppConfig>, opts?: { silent?: boolean }) {
  if (!config) return;
  config = { ...config, ...partial };
  void setConfig(config)
    .then(() => {
      if (!opts?.silent) toast(t("toast.saved"));
    })
    .catch(() => {
      if (!opts?.silent) toast(t("toast.saveFailed"));
    });
}

function openSettings() {
  if (!config) return;
  setLanguage.value = config.language;
  setTheme.value = config.theme;
  setZoom.value = String(config.zoom_sensitivity);
  setZoomVal.textContent = `${config.zoom_sensitivity.toFixed(1)}×`;
  setHotkey.value = config.hotkeys.show_screenshot;
  setColorHotkey.value = config.hotkeys.copy_color;
  setMagnifier.checked = config.magnifier_enabled;
  setMinimize.checked = config.minimize_on_close;
  setAutostart.checked = config.launch_on_startup;
  settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  settingsOverlay.classList.add("hidden");
}

$("btn-settings").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
settingsOverlay.addEventListener("mousedown", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsOverlay.classList.contains("hidden")) {
    closeSettings();
  }
});

setLanguage.addEventListener("change", () => {
  const lang = setLanguage.value as Lang;
  saveSettings({ language: lang });
  setLang(lang);
  applyI18n(document);
  refreshStatus();
  // 属性面板字段名随语言变化
  if (viewMode === "single" && activeIndex >= 0) renderProps(images[activeIndex]);
});
setTheme.addEventListener("change", () => {
  const theme = setTheme.value as AppConfig["theme"];
  saveSettings({ theme });
  applyTheme(theme);
});
setZoom.addEventListener("input", () => {
  setZoomVal.textContent = `${Number(setZoom.value).toFixed(1)}×`;
});
setZoom.addEventListener("change", () => {
  saveSettings({ zoom_sensitivity: Number(setZoom.value) });
});
setMagnifier.addEventListener("change", () => {
  saveSettings({ magnifier_enabled: setMagnifier.checked });
});
setMinimize.addEventListener("change", () => {
  saveSettings({ minimize_on_close: setMinimize.checked });
});
setAutostart.addEventListener("change", () => {
  saveSettings({ launch_on_startup: setAutostart.checked }, { silent: true });
  void setLaunchOnStartup(setAutostart.checked)
    .then(() =>
      toast(setAutostart.checked ? t("toast.autostartOn") : t("toast.autostartOff")),
    )
    .catch((e) => {
      setAutostart.checked = !setAutostart.checked;
      toast(t("toast.autostartFailed", { msg: String(e) }));
    });
});
$("set-hotkey-apply").addEventListener("click", () => {
  const value = setHotkey.value.trim();
  if (!value) {
    toast(t("toast.hotkeyEmpty"));
    return;
  }
  void setShowScreenshotHotkey(value)
    .then(() => {
      if (config) {
        config = { ...config, hotkeys: { ...config.hotkeys, show_screenshot: value } };
      }
      toast(t("toast.hotkeySet", { key: value }));
    })
    .catch((e) => toast(t("toast.hotkeyFailed", { msg: String(e) })));
});
$("set-color-hotkey-apply").addEventListener("click", () => {
  const value = setColorHotkey.value.trim();
  if (!value) {
    toast(t("toast.hotkeyEmpty"));
    return;
  }
  if (!value.includes("+")) {
    toast(t("toast.hotkeyEmpty"));
    return;
  }
  saveSettings({ hotkeys: { ...(config?.hotkeys ?? { show_screenshot: "Alt+S", copy_color: "Alt+C" }), copy_color: value } }, { silent: true });
  toast(t("toast.colorHotkeySet", { key: value }));
});

// ---------- 启动 ----------
(async () => {
  try {
    config = await getConfig();
    setLang(config.language);
    applyTheme(config.theme);
  } catch (e) {
    console.error("读取配置失败", e);
    applyTheme("system");
  }
  applyI18n(document);
  refreshStatus();
  // 记住上次的语言仅作展示；无目录状态由用户操作进入
})();

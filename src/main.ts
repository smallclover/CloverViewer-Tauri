import "./styles.css";
import { applyI18n, setLang, t, type Lang } from "./i18n";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { APP_VERSION } from "./version";
import { createToast, playEnterAnimation, setAnimatedVisibility } from "./ui/presentation";
import {
  createGridLayout,
  GRID_GAP,
  thumbnailPixelSize,
  THUMB_WIDTHS,
  visibleItemRange,
} from "./viewer/grid-layout";
import { createImageSourceResolver } from "./viewer/image-source";
import {
  type AppConfig,
  type ImageEntry,
  copyImageFile,
  fileSrc,
  formatDimensions,
  formatSize,
  getAppInfo,
  getConfig,
  getImageInfo,
  getThumbnail,
  listImages,
  openUrl,
  readImageData,
  setConfig,
  setLaunchOnStartup,
  setShowScreenshotHotkey,
  setScrollCaptureHotkey,
  takeStartupNotices,
} from "./api";

// ---------- 状态 ----------
let config: AppConfig | null = null;
let currentDir = "";
let images: ImageEntry[] = [];
let activeIndex = -1; // 当前单图索引
let viewMode: "grid" | "single" = "grid";
let propsVisible = false; // 属性栏默认收起，避免初次进入单图就压缩画布

// 单图缩放/平移/旋转/翻转
let scale = 1;
let fitMode = true;
const pan = { x: 0, y: 0 };
let rotation = 0; // 0/90/180/270
let flipH = false;
let flipV = false;

const imageSource = createImageSourceResolver({ fileSrc, readImageData });

// 属性面板渲染 token（防止快速切换时旧 EXIF 异步结果串台）
let propsToken = 0;

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const emptyState = $("empty-state");
const contentHeader = $("content-header");
const gridView = $("grid-view");
const grid = $("grid");
const gridSpacer = $("grid-spacer");
const singleView = $("single-view");
const imgStage = $("img-stage");
const singleImg = $<HTMLImageElement>("single-img");
const propsList = $("props-list");
const propsPanel = $("props-panel");
const breadcrumb = $("breadcrumb");
const gridMenu = $("grid-menu");
const gridSort = $<HTMLButtonElement>("grid-sort");
const gridSize = $<HTMLButtonElement>("grid-size");
const gridCount = $("grid-count");
const backToGrid = $<HTMLButtonElement>("back-to-grid");
const backToGridName = $("back-to-grid-name");
const statusLeft = $("status-left");
const statusRight = $("status-right");
const btnProps = $("btn-props");
const btnRotate = $("btn-rotate");
const btnFlipH = $("btn-flip-h");
const btnFlipV = $("btn-flip-v");
const btnResetTransform = $("btn-reset-transform");
const imageTools = $("image-tools");
const navPrev = $<HTMLButtonElement>("nav-prev");
const navNext = $<HTMLButtonElement>("nav-next");
const dropOverlay = $("drop-overlay");
const toastEl = $("toast");
const ctxMenu = $("context-menu");

// 左侧导航与原型保持同一组 Lucide 轮廓：FolderOpen / Images / Settings2 / CircleHelp。
function setRailIcon(id: string, paths: string) {
  $(id).innerHTML =
    `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
setRailIcon(
  "btn-open",
  `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="m6 14 1.5-2.9A2 2 0 0 1 9.28 10H20a2 2 0 0 1 1.94 2.5l-1.5 6A2 2 0 0 1 18.5 20H4a2 2 0 0 1-2-2V7"/>`,
);
setRailIcon(
  "btn-settings",
  `<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>`,
);
setRailIcon(
  "btn-about",
  `<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.83 1c0 2-3 2-3 4"/><path d="M12 17h.01"/>`,
);

const toast = createToast(toastEl);

// ---------- 主题 ----------
function applyTheme(theme: "dark" | "light" | "system") {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

// ---------- 面包屑 ----------
function renderBreadcrumb() {
  breadcrumb.innerHTML = "";
  if (!currentDir) return;
  const parts = currentDir.replace(/\\/g, "/").split("/").filter(Boolean);
  const icon = document.createElement("span");
  icon.className = "breadcrumb-icon";
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  const name = document.createElement("span");
  name.className = "crumb current";
  name.textContent = parts[parts.length - 1] ?? currentDir;
  backToGridName.textContent = name.textContent;
  breadcrumb.append(icon, name);
}

// ---------- 目录加载 ----------
async function openDirectory(dir: string) {
  try {
    const entries = await listImages(dir);
    images = entries;
    currentDir = dir;
    imageSource.clear();
    renderBreadcrumb();
    if (entries.length === 0) {
      toast(t("toast.noImages"));
    }
    activeIndex = -1;
    showGrid();
    refreshStatus();
  } catch (e) {
    toast(t("toast.openFailed", { msg: String(e) }), "error");
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

// 单图专属工具栏按钮（旋转/翻转）显隐
function setImageToolsVisible(v: boolean) {
  imageTools.classList.toggle("hidden", !v);
  btnRotate.classList.toggle("hidden", !v);
  btnFlipH.classList.toggle("hidden", !v);
  btnFlipV.classList.toggle("hidden", !v);
  if (v) playEnterAnimation(imageTools, "tools-enter");
}

// ---------- 网格视图（窗口化虚拟滚动） ----------
let thumbSizeIndex = 1;
let cellWidth = THUMB_WIDTHS[thumbSizeIndex];
let thumbHeight = Math.round(cellWidth * 0.744);
let cellHeight = thumbHeight + 52;
let newestFirst = true;
let cols = 4;
const renderedCells = new Map<number, HTMLElement>();
let scrollRaf = 0;

function thumbSize(): number {
  return thumbnailPixelSize(cellWidth);
}

function showGrid() {
  viewMode = "grid";
  // 初始空态不需要这条上下文栏；一旦用户选定目录（即使目录里没有图片）就恢复。
  contentHeader.classList.remove("hidden");
  emptyState.classList.toggle("hidden", images.length > 0 || !!currentDir);
  gridView.classList.toggle("hidden", images.length === 0);
  singleView.classList.add("hidden");
  gridMenu.classList.remove("hidden");
  breadcrumb.classList.remove("hidden");
  gridCount.classList.remove("hidden");
  backToGrid.classList.add("hidden");
  btnProps.classList.add("hidden");
  setImageToolsVisible(false);
  refreshGridMenu();
  renderGrid();
  playEnterAnimation(gridView);
  updateNavButtons();
  refreshStatus();
}

function renderGrid() {
  const layout = createGridLayout(gridView.clientWidth, images.length, cellWidth);
  cols = layout.columns;
  thumbHeight = layout.thumbHeight;
  cellHeight = layout.cellHeight;
  gridSpacer.style.height = `${layout.totalHeight}px`;
  for (const [, el] of renderedCells) el.remove();
  renderedCells.clear();
  renderVisible();
}

function renderVisible() {
  const scrollTop = gridView.scrollTop;
  const viewH = gridView.clientHeight;
  const layout = createGridLayout(gridView.clientWidth, images.length, cellWidth);
  const [from, to] = visibleItemRange(scrollTop, viewH, images.length, layout);

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
  cell.className = `cell${i === activeIndex ? " active" : ""}`;
  cell.dataset.index = String(i);
  const col = i % cols;
  const row = Math.floor(i / cols);
  cell.style.left = `${col * (cellWidth + GRID_GAP)}px`;
  cell.style.top = `${row * (cellHeight + GRID_GAP)}px`;
  cell.style.width = `${cellWidth}px`;

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.style.height = `${thumbHeight}px`;
  const img = document.createElement("img");
  img.alt = entry.name;
  img.draggable = false;
  thumb.appendChild(img);
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = entry.name;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = formatDimensions(entry.width, entry.height);
  cell.appendChild(thumb);
  cell.appendChild(label);
  cell.appendChild(meta);

  cell.addEventListener("click", () => showSingle(i));

  // 缩略图：Rust 缩略图优先，失败回退原图
  getThumbnail(entry.path, thumbSize())
    .then((dataUrl) => {
      img.src = dataUrl;
    })
    .catch(() => {
      void imageSource.for(entry).then((s) => {
        img.src = s;
      });
    });

  return cell;
}

function refreshGridMenu() {
  gridSort.textContent = newestFirst ? t("view.sortNewest") : t("view.sortOldest");
  gridSize.textContent = t(
    ["view.thumbSmall", "view.thumbMedium", "view.thumbLarge"][thumbSizeIndex],
  );
}

function toggleGridSort() {
  newestFirst = !newestFirst;
  const activePath = activeIndex >= 0 ? images[activeIndex]?.path : undefined;
  images.sort((a, b) => {
    const delta = new Date(a.modified).getTime() - new Date(b.modified).getTime();
    return newestFirst ? -delta : delta;
  });
  activeIndex = activePath ? images.findIndex((entry) => entry.path === activePath) : -1;
  refreshGridMenu();
  renderGrid();
}

function cycleGridSize() {
  thumbSizeIndex = (thumbSizeIndex + 1) % THUMB_WIDTHS.length;
  cellWidth = THUMB_WIDTHS[thumbSizeIndex];
  thumbHeight = Math.round(cellWidth * 0.744);
  cellHeight = thumbHeight + 52;
  refreshGridMenu();
  renderGrid();
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
  if (viewMode === "single") {
    applyTransform(); // 面板显隐改变可视区域，重算适应/平移
    refreshStatus();
  }
}

// ---------- 单图视图 ----------
function showSingle(index: number) {
  if (index < 0 || index >= images.length) return;
  activeIndex = index;
  viewMode = "single";
  emptyState.classList.add("hidden");
  gridView.classList.add("hidden");
  singleView.classList.remove("hidden");
  playEnterAnimation(singleView);
  gridMenu.classList.add("hidden");
  breadcrumb.classList.add("hidden");
  gridCount.classList.add("hidden");
  backToGrid.classList.remove("hidden");
  btnProps.classList.remove("hidden");
  setImageToolsVisible(true);
  updateCellActive();
  applyPropsState();
  updateNavButtons();

  const entry = images[index];
  fitMode = true;
  scale = 1;
  rotation = 0;
  flipH = false;
  flipV = false;
  pan.x = 0;
  pan.y = 0;
  applyTransform();
  void imageSource.for(entry).then((src) => {
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
    const zoom = `${Math.round((fitMode ? fitScale() : scale) * 100)}%`;
    statusRight.textContent = `${activeIndex + 1} / ${images.length} · ${formatDimensions(entry.width, entry.height)} · ${formatSize(entry.size)} · ${zoom}`;
    gridCount.classList.add("hidden");
  } else if (currentDir) {
    // 文件夹名与图片数量已在顶部上下文栏显示；底部只承担即时状态。
    statusLeft.textContent = t("status.ready");
    statusRight.textContent = "";
    gridCount.textContent = t("status.imageCount", { count: images.length });
    gridCount.classList.remove("hidden");
  } else {
    statusLeft.textContent = t("status.ready");
    statusRight.textContent = "";
    gridCount.classList.add("hidden");
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
  // 留出稳定的画布呼吸空间；用户仍可滚轮/双击进入 100% 或自由缩放。
  return Math.min(rect.width / w, rect.height / h) * 0.88;
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

singleImg.addEventListener("load", () => {
  applyTransform();
  playEnterAnimation(singleImg, "image-enter");
});
window.addEventListener("resize", () => {
  if (viewMode === "single") {
    applyTransform();
    refreshStatus();
  } else if (viewMode === "grid" && images.length > 0) renderGrid();
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
  refreshStatus();
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
  refreshStatus();
});

// 旋转/翻转
function rotateImage() {
  // 旋转前后保持实际显示比例：适应模式若重新 fit，会让图片看上去被放大/缩小。
  const renderedScale = fitMode ? fitScale() : scale;
  rotation = (rotation + 90) % 360;
  fitMode = false;
  scale = renderedScale;
  applyTransform();
  refreshStatus();
}
function flipHorizontal() {
  const renderedScale = fitMode ? fitScale() : scale;
  fitMode = false;
  scale = renderedScale;
  flipH = !flipH;
  applyTransform();
  refreshStatus();
}
function flipVertical() {
  const renderedScale = fitMode ? fitScale() : scale;
  fitMode = false;
  scale = renderedScale;
  flipV = !flipV;
  applyTransform();
  refreshStatus();
}
function resetImageTransform() {
  // 回到刚打开本图时的完整初始状态：适应画布、居中、未旋转、未翻转。
  // 胶囊本身的双击已在下方隔离，因此不会与画布“适应 ↔ 100%”冲突。
  rotation = 0;
  flipH = false;
  flipV = false;
  pan.x = 0;
  pan.y = 0;
  fitMode = true;
  scale = 1;
  applyTransform();
  refreshStatus();
}

// ---------- 导航 ----------
function navigate(delta: number) {
  if (images.length === 0) return;
  const next = activeIndex + delta;
  // 不循环：到首/尾就不再切换（首尾按钮置灰）
  if (next < 0 || next > images.length - 1) return;
  showSingle(next);
}

// 更新单图左右切图按钮的置灰状态（首张禁用上一张，末张禁用下一张）
function updateNavButtons() {
  if (viewMode !== "single") {
    navPrev.disabled = true;
    navNext.disabled = true;
    return;
  }
  navPrev.disabled = activeIndex <= 0;
  navNext.disabled = activeIndex >= images.length - 1;
}

// ---------- 键盘 ----------
window.addEventListener("keydown", (e) => {
  // 关于页 / 设置面板打开时屏蔽查看器快捷键：它们盖住了画面，
  // 否则按 R 会转动背后的图、Ctrl+O 会弹出文件夹对话框。
  if (!aboutOverlay.classList.contains("hidden")) return;
  if (!settingsOverlay.classList.contains("hidden")) return;
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
backToGrid.addEventListener("click", showGrid);
gridSort.addEventListener("click", toggleGridSort);
gridSize.addEventListener("click", cycleGridSize);
btnProps.addEventListener("click", toggleProps);
btnRotate.addEventListener("click", rotateImage);
btnFlipH.addEventListener("click", flipHorizontal);
btnFlipV.addEventListener("click", flipVertical);
btnResetTransform.addEventListener("click", resetImageTransform);
// 工具胶囊位于画布内：隔离手势，避免连续点击“还原”冒泡成画布双击，
// 意外触发“适应窗口 ↔ 100%”缩放切换。
imageTools.addEventListener("mousedown", (e) => e.stopPropagation());
imageTools.addEventListener("dblclick", (e) => e.stopPropagation());
// 单图切图按钮：点击切换 + 阻止 mousedown 冒泡，避免误触发拖拽平移
navPrev.addEventListener("mousedown", (e) => e.stopPropagation());
navNext.addEventListener("mousedown", (e) => e.stopPropagation());
navPrev.addEventListener("click", () => navigate(-1));
navNext.addEventListener("click", () => navigate(1));

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
      dir === "East" ||
      dir === "West" ||
      dir === "South" ||
      dir === "SouthEast" ||
      dir === "SouthWest"
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
  ctxMenu.classList.remove("is-visible");
  // 先显示再测量，clamp 到视口内
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 6))}px`;
  ctxMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 6))}px`;
  requestAnimationFrame(() => ctxMenu.classList.add("is-visible"));
}

function hideContextMenu() {
  setAnimatedVisibility(ctxMenu, false, 120);
}

// 复制图片走原生剪贴板，避免 Windows WebView2 对 ClipboardItem 图片支持不完整。
// 这也让从滚动截图打开的长图和截图覆盖窗使用同一条可靠路径。
async function copyImageBitmap(entry: ImageEntry) {
  try {
    await copyImageFile(entry.path);
    toast(t("toast.copiedImage"), "success");
  } catch (e) {
    toast(t("toast.copyFailed", { msg: String(e) }), "error");
  }
}

async function copyImagePath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    toast(t("toast.copiedPath"), "success");
  } catch (e) {
    toast(t("toast.copyFailed", { msg: String(e) }), "error");
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
    setAnimatedVisibility(dropOverlay, true);
  } else {
    setAnimatedVisibility(dropOverlay, false);
    if (payload.type === "drop" && payload.paths.length > 0) {
      void openFileOrFolder(payload.paths[0]);
    }
  }
});

// ---------- 设置面板 ----------
const settingsOverlay = $("settings-overlay");
const btnSettings = $("btn-settings");
const setLanguage = $<HTMLSelectElement>("set-language");
const setTheme = $<HTMLSelectElement>("set-theme");
const setZoom = $<HTMLInputElement>("set-zoom");
const setZoomVal = $("set-zoom-val");
const setHotkey = $<HTMLInputElement>("set-hotkey");
const setColorHotkey = $<HTMLInputElement>("set-color-hotkey");
const setScrollHotkey = $<HTMLInputElement>("set-scroll-hotkey");
const setMagnifier = $<HTMLInputElement>("set-magnifier");
const setMinimize = $<HTMLInputElement>("set-minimize");
const setAutostart = $<HTMLInputElement>("set-autostart");
const checkUpdateButton = $<HTMLButtonElement>("check-update");
const updateOverlay = $("update-overlay");
const updateVersion = $("update-version");
const updateNotes = $("update-notes");
const updateNowButton = $<HTMLButtonElement>("update-now");
const updateLaterButton = $<HTMLButtonElement>("update-later");
const settingsTabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"),
);
const settingSections = Array.from(
  document.querySelectorAll<HTMLElement>("[data-settings-section]"),
);

function selectSettingsTab(tab: string) {
  settingsTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === tab);
  });
  settingSections.forEach((section) => {
    const selected = section.dataset.settingsSection === tab;
    section.hidden = !selected;
    if (selected) playEnterAnimation(section, "tab-enter");
  });
}

function saveSettings(partial: Partial<AppConfig>, opts?: { silent?: boolean }) {
  if (!config) return;
  config = { ...config, ...partial };
  void setConfig(config)
    .then(() => {
      if (!opts?.silent) toast(t("toast.saved"), "success");
    })
    .catch(() => {
      if (!opts?.silent) toast(t("toast.saveFailed"), "error");
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
  // 旧配置文件里没有这个字段（serde default 只在后端生效），前端兜一个默认值
  setScrollHotkey.value = config.hotkeys.scroll_capture || "Alt+Shift+S";
  setMagnifier.checked = config.magnifier_enabled;
  setMinimize.checked = config.minimize_on_close;
  setAutostart.checked = config.launch_on_startup;
  selectSettingsTab("general");
  btnSettings.classList.add("active");
  btnSettings.setAttribute("aria-pressed", "true");
  setAnimatedVisibility(settingsOverlay, true, 220);
}

function closeSettings() {
  setAnimatedVisibility(settingsOverlay, false, 220);
  btnSettings.classList.remove("active");
  btnSettings.setAttribute("aria-pressed", "false");
}

btnSettings.addEventListener("click", () => {
  if (!settingsOverlay.classList.contains("is-visible")) openSettings();
  else closeSettings();
});
settingsTabs.forEach((button) => {
  button.addEventListener("click", () =>
    selectSettingsTab(button.dataset.settingsTab ?? "general"),
  );
});
settingsOverlay.addEventListener("mousedown", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!updateOverlay.classList.contains("hidden")) {
    dismissUpdateDialog(false);
    return;
  }
  // 关于页在最上层，优先关闭；两个都关着时 Esc 交给查看器（退出单图视图）
  if (!aboutOverlay.classList.contains("hidden")) {
    closeAbout();
    return;
  }
  if (!settingsOverlay.classList.contains("hidden")) closeSettings();
});

setLanguage.addEventListener("change", () => {
  const lang = setLanguage.value as Lang;
  saveSettings({ language: lang });
  setLang(lang);
  applyI18n(document);
  if (!updateOverlay.classList.contains("hidden") && !updateNotes.dataset.hasNotes) {
    updateNotes.textContent = t("update.noReleaseNotes");
  }
  refreshGridMenu();
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
      toast(setAutostart.checked ? t("toast.autostartOn") : t("toast.autostartOff"), "success"),
    )
    .catch((e) => {
      setAutostart.checked = !setAutostart.checked;
      toast(t("toast.autostartFailed", { msg: String(e) }), "error");
    });
});

let checkingForUpdate = false;
let updateDialogResolver: ((install: boolean) => void) | undefined;

function dismissUpdateDialog(install: boolean) {
  const resolve = updateDialogResolver;
  if (!resolve) return;
  updateDialogResolver = undefined;
  setAnimatedVisibility(updateOverlay, false, 180);
  resolve(install);
}

function showUpdateDialog(version: string, notes?: string): Promise<boolean> {
  updateVersion.textContent = `v${version}`;
  updateNotes.dataset.hasNotes = notes ? "true" : "";
  updateNotes.textContent = notes || t("update.noReleaseNotes");
  setAnimatedVisibility(updateOverlay, true, 180);
  window.requestAnimationFrame(() => updateNowButton.focus());
  return new Promise((resolve) => {
    updateDialogResolver = resolve;
  });
}

updateNowButton.addEventListener("click", () => dismissUpdateDialog(true));
updateLaterButton.addEventListener("click", () => dismissUpdateDialog(false));
updateOverlay.addEventListener("mousedown", (event) => {
  if (event.target === updateOverlay) dismissUpdateDialog(false);
});

/**
 * 检查并安装 Tauri 已签名的更新包。
 *
 * 仅在用户手动点击“检查更新”后执行，并明确反馈检查结果。
 * 下载与安装均由 Tauri updater 完成，安装前会校验发布时生成的 .sig 签名。
 */
async function checkForUpdate() {
  if (checkingForUpdate) return;
  checkingForUpdate = true;
  checkUpdateButton.disabled = true;
  toast(t("update.checking"), "info");

  try {
    const update = await check();
    if (!update) {
      toast(t("update.latest"), "success");
      return;
    }

    if (!(await showUpdateDialog(update.version, update.body?.trim()))) return;

    let downloaded = 0;
    let contentLength = 0;
    let lastPercent = -1;
    toast(t("update.downloading", { percent: 0 }), "info");
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (contentLength > 0) {
          const percent = Math.min(100, Math.floor((downloaded / contentLength) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            toast(t("update.downloading", { percent }), "info");
          }
        }
      }
    });
    toast(t("update.installing"), "success");
    await relaunch();
  } catch (error) {
    // 开发环境、离线状态或尚未配置首个 Release 都不应影响正常使用。
    console.warn("检查更新失败", error);
    toast(t("update.failed", { msg: String(error) }), "error");
  } finally {
    checkingForUpdate = false;
    checkUpdateButton.disabled = false;
  }
}

checkUpdateButton.addEventListener("click", () => void checkForUpdate());
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
      toast(t("toast.hotkeySet", { key: value }), "success");
    })
    .catch((e) => toast(t("toast.hotkeyFailed", { msg: String(e) }), "error"));
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
  saveSettings(
    {
      hotkeys: {
        ...(config?.hotkeys ?? {
          show_screenshot: "Alt+S",
          copy_color: "Alt+C",
          scroll_capture: "Alt+Shift+S",
        }),
        copy_color: value,
      },
    },
    { silent: true },
  );
  toast(t("toast.colorHotkeySet", { key: value }), "success");
});
// 滚动截图专属热键：与截图热键同样需要真正重注册（不能只写配置）
$("set-scroll-hotkey-apply").addEventListener("click", () => {
  const value = setScrollHotkey.value.trim();
  if (!value?.includes("+")) {
    toast(t("toast.hotkeyEmpty"));
    return;
  }
  void setScrollCaptureHotkey(value)
    .then(() => {
      if (config) {
        config = { ...config, hotkeys: { ...config.hotkeys, scroll_capture: value } };
      }
      toast(t("toast.hotkeySet", { key: value }), "success");
    })
    .catch((e) => toast(t("toast.hotkeyFailed", { msg: String(e) }), "error"));
});

// ---------- 关于页 ----------
const aboutOverlay = $("about-overlay");
const aboutVersion = $("about-version");
const infoVersion = $("info-version");
const infoIdentifier = $("info-identifier");
const infoUi = $("info-ui");
const infoRuntime = $("info-runtime");

/** 关于页里的外部链接：仓库 / Releases / 原版 CloverViewer / 许可证 */
const ABOUT_LINKS: Array<[string, string]> = [
  ["about-link-repo", "https://github.com/smallclover/CloverViewer-Tauri"],
  ["about-link-releases", "https://github.com/smallclover/CloverViewer-Tauri/releases"],
  ["about-link-original", "https://github.com/smallclover/CloverViewer"],
  ["about-link-license", "https://github.com/smallclover/CloverViewer-Tauri/blob/main/LICENSE"],
];

let aboutInfoLoaded = false;

/**
 * 先用构建时版本填充，再用 Tauri 运行时真实值覆盖。
 * 即使后端暂不可用，About 也会显示本次构建的版本。
 */
async function fillAboutInfo() {
  aboutVersion.textContent = `v${APP_VERSION}`;
  infoVersion.textContent = APP_VERSION;

  try {
    const info = await getAppInfo();
    aboutVersion.textContent = `v${info.version}`;
    infoVersion.textContent = info.version;
    infoIdentifier.textContent = info.identifier;

    // 渲染引擎版本：WebView2 的 UA 里带 Edg/<版本>
    const parts = [`Tauri ${info.tauri}`];
    const edg = /Edg\/(\d+)/.exec(navigator.userAgent);
    if (edg) parts.push(`WebView2 ${edg[1]}`);
    infoUi.textContent = parts.join(" · ");

    const os = info.os === "windows" ? "Windows" : info.os;
    const arch = info.arch === "x86_64" ? "x64" : info.arch;
    infoRuntime.textContent = `${os} · ${arch}`;
  } catch {
    // 后端不可用时保留来自 package.json 的构建版本。
  }
}

function openAbout() {
  setAnimatedVisibility(aboutOverlay, true, 220);
  if (!aboutInfoLoaded) {
    aboutInfoLoaded = true;
    void fillAboutInfo();
  }
}

function closeAbout() {
  setAnimatedVisibility(aboutOverlay, false, 220);
}

$("btn-about").addEventListener("click", openAbout);
$("about-close").addEventListener("click", closeAbout);

// 链接交给系统默认浏览器打开（后端只放行 https://）。
// href 仍保留真实地址，便于中键新开、右键复制链接。
for (const [id, url] of ABOUT_LINKS) {
  $(id).addEventListener("click", (e) => {
    e.preventDefault();
    void openUrl(url).catch((err) => toast(String(err), "error"));
  });
}

// ---------- 滚动截图：后端把长图落盘后通知主窗口打开 ----------
async function initScrollCaptureBridge() {
  // 「在查看器中打开」：后端已保存临时 PNG 并把主窗口显示出来，这里负责载入这张图
  await listen<{ path: string }>("open-image", async (e) => {
    const path = e.payload?.path;
    if (!path) return;
    try {
      await openFileOrFolder(path);
      toast(t("toast.opened"), "success");
    } catch (err) {
      toast(String(err), "error");
    }
  });
}

// ---------- 启动阶段提示（热键冲突等） ----------
async function showStartupNotices() {
  try {
    const notices = await takeStartupNotices();
    for (const n of notices) {
      if (n.kind === "hotkey_fallback") {
        toast(t("notice.hotkeyFallback", { wanted: n.wanted ?? "", used: n.used ?? "" }), "info");
      } else if (n.kind === "hotkey_conflict") {
        toast(t("notice.hotkeyConflict", { wanted: n.wanted ?? "" }), "error");
      }
    }
  } catch {
    // 取不到就算了，不影响主流程
  }
}

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
  void initScrollCaptureBridge();
  void showStartupNotices();
  // 记住上次的语言仅作展示；无目录状态由用户操作进入
})();

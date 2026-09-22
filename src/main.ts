import "./styles.css";
import { applyI18n, setLang, t } from "./i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { createToast, playEnterAnimation } from "./ui/presentation";
import { createAboutController } from "./ui/about-controller";
import { createContextMenuController } from "./ui/context-menu-controller";
import { bindFileDrop, bindOpenImageBridge, showStartupNotices } from "./ui/app-bridges";
import { createSettingsController } from "./ui/settings-controller";
import { bindWindowChrome } from "./ui/window-chrome";
import { createGridController } from "./viewer/grid-controller";
import { createImageSourceResolver } from "./viewer/image-source";
import { createImagePropertiesController } from "./viewer/image-properties-controller";
import { createSingleImageController } from "./viewer/single-image-controller";
import { createViewerSession } from "./viewer/viewer-session";
import {
  type AppConfig,
  type ImageEntry,
  copyImageFile,
  fileSrc,
  formatDimensions,
  formatSize,
  getConfig,
  getImageInfo,
  getThumbnail,
  listImages,
  readImageData,
} from "./api";

// ---------- 状态 ----------
let config: AppConfig | null = null;
const viewerSession = createViewerSession();

const imageSource = createImageSourceResolver({ fileSrc, readImageData });

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

// 标题栏菜单：同一时间只展开一个，执行菜单项或按 Esc 后收起。
const appMenus = Array.from(document.querySelectorAll<HTMLDetailsElement>("#toolbar .app-menu"));
const closeMenus = (except?: HTMLDetailsElement) => {
  for (const menu of appMenus) {
    if (menu !== except) menu.open = false;
  }
};
appMenus.forEach((menu) => {
  menu.addEventListener("toggle", () => {
    if (menu.open) closeMenus(menu);
  });
  menu.querySelectorAll<HTMLButtonElement>("button").forEach((item) => {
    item.addEventListener("click", () => {
      menu.open = false;
    });
  });
});
document.addEventListener("mousedown", (event) => {
  if (!(event.target as HTMLElement).closest("#toolbar")) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});

const toast = createToast(toastEl);
const singleImageController = createSingleImageController({
  stage: imgStage,
  image: singleImg,
  isActive: () => viewerSession.viewMode === "single",
  getZoomSensitivity: () => config?.zoom_sensitivity ?? 1,
  onChange: refreshStatus,
  playEnterAnimation,
});
const imagePropertiesController = createImagePropertiesController({
  list: propsList,
  getImageInfo,
  formatDimensions,
  formatSize,
  translate: t,
});

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
  if (!viewerSession.currentDir) return;
  const parts = viewerSession.currentDir.replace(/\\/g, "/").split("/").filter(Boolean);
  const icon = document.createElement("span");
  icon.className = "breadcrumb-icon";
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  const name = document.createElement("span");
  name.className = "crumb current";
  name.textContent = parts[parts.length - 1] ?? viewerSession.currentDir;
  backToGridName.textContent = name.textContent;
  breadcrumb.append(icon, name);
}

// ---------- 目录加载 ----------
async function openDirectory(dir: string) {
  try {
    const entries = await listImages(dir);
    viewerSession.setDirectory(dir, entries);
    imageSource.clear();
    renderBreadcrumb();
    if (entries.length === 0) {
      toast(t("toast.noImages"));
    }
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
  const idx = viewerSession.images.findIndex((img) => img.name === fileName);
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
const gridController = createGridController({
  gridView,
  grid,
  spacer: gridSpacer,
  sortButton: gridSort,
  sizeButton: gridSize,
  session: viewerSession,
  imageSource,
  getThumbnail,
  formatDimensions,
  translate: t,
  onSelect: showSingle,
});

function showGrid() {
  viewerSession.viewMode = "grid";
  // 初始空态不需要这条上下文栏；一旦用户选定目录（即使目录里没有图片）就恢复。
  contentHeader.classList.remove("hidden");
  emptyState.classList.toggle(
    "hidden",
    viewerSession.images.length > 0 || !!viewerSession.currentDir,
  );
  gridView.classList.toggle("hidden", viewerSession.images.length === 0);
  singleView.classList.add("hidden");
  gridMenu.classList.remove("hidden");
  breadcrumb.classList.remove("hidden");
  gridCount.classList.remove("hidden");
  backToGrid.classList.add("hidden");
  btnProps.classList.add("hidden");
  setImageToolsVisible(false);
  gridController.refreshMenu();
  gridController.renderGrid();
  playEnterAnimation(gridView);
  updateNavButtons();
  refreshStatus();
}

// ---------- 属性栏开关 ----------
function toggleProps() {
  viewerSession.propsVisible = !viewerSession.propsVisible;
  applyPropsState();
}

function applyPropsState() {
  btnProps.classList.toggle("active", viewerSession.propsVisible);
  propsPanel.classList.toggle("collapsed", !viewerSession.propsVisible);
  if (viewerSession.viewMode === "single") {
    singleImageController.applyTransform(); // 面板显隐改变可视区域，重算适应/平移
    refreshStatus();
  }
}

// ---------- 单图视图 ----------
function showSingle(index: number) {
  if (index < 0 || index >= viewerSession.images.length) return;
  viewerSession.activeIndex = index;
  viewerSession.viewMode = "single";
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
  gridController.updateActive();
  applyPropsState();
  updateNavButtons();

  const entry = viewerSession.images[index];
  singleImageController.reset();
  void imageSource.for(entry).then((src) => {
    singleImg.src = src;
  });
  imagePropertiesController.render(entry);
  refreshStatus();
  preloadNeighbors(index);
}

// 刷新状态栏文案（语言切换时也会调用）
function refreshStatus() {
  if (
    viewerSession.viewMode === "single" &&
    viewerSession.activeIndex >= 0 &&
    viewerSession.images[viewerSession.activeIndex]
  ) {
    const entry = viewerSession.images[viewerSession.activeIndex];
    statusLeft.textContent = entry.name;
    const zoom = `${Math.round(singleImageController.displayedScale() * 100)}%`;
    statusRight.textContent = `${viewerSession.activeIndex + 1} / ${viewerSession.images.length} · ${formatDimensions(entry.width, entry.height)} · ${formatSize(entry.size)} · ${zoom}`;
    gridCount.classList.add("hidden");
  } else if (viewerSession.currentDir) {
    // 文件夹名与图片数量已在顶部上下文栏显示；底部只承担即时状态。
    statusLeft.textContent = t("status.ready");
    statusRight.textContent = "";
    gridCount.textContent = t("status.imageCount", { count: viewerSession.images.length });
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
    if (i < 0 || i >= viewerSession.images.length) continue;
    const entry = viewerSession.images[i];
    if (entry.web_supported) {
      const img = new Image();
      img.src = fileSrc(entry.path);
    }
  }
}

window.addEventListener("resize", () => {
  if (viewerSession.viewMode === "grid" && viewerSession.images.length > 0) {
    gridController.renderGrid();
  }
});

// ---------- 导航 ----------
function navigate(delta: number) {
  if (viewerSession.images.length === 0) return;
  const next = viewerSession.activeIndex + delta;
  // 不循环：到首/尾就不再切换（首尾按钮置灰）
  if (next < 0 || next > viewerSession.images.length - 1) return;
  showSingle(next);
}

// 更新单图左右切图按钮的置灰状态（首张禁用上一张，末张禁用下一张）
function updateNavButtons() {
  if (viewerSession.viewMode !== "single") {
    navPrev.disabled = true;
    navNext.disabled = true;
    return;
  }
  navPrev.disabled = viewerSession.activeIndex <= 0;
  navNext.disabled = viewerSession.activeIndex >= viewerSession.images.length - 1;
}

// ---------- 键盘 ----------
window.addEventListener("keydown", (e) => {
  // 关于页 / 设置面板打开时屏蔽查看器快捷键：它们盖住了画面，
  // 否则按 R 会转动背后的图、Ctrl+O 会弹出文件夹对话框。
  if (aboutController.isOpen()) return;
  if (settingsController.isOpen()) return;
  if (e.ctrlKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    void pickFolder();
    return;
  }
  switch (e.key) {
    case "ArrowLeft":
      if (viewerSession.viewMode === "single") navigate(-1);
      break;
    case "ArrowRight":
      if (viewerSession.viewMode === "single") navigate(1);
      break;
    case "Escape":
      if (viewerSession.viewMode === "single") showGrid();
      break;
    case "Tab":
      e.preventDefault();
      if (viewerSession.viewMode === "single") showGrid();
      else if (viewerSession.images.length > 0) showSingle(Math.max(viewerSession.activeIndex, 0));
      break;
    case "0":
      if (viewerSession.viewMode === "single") {
        singleImageController.zoomToFit();
      }
      break;
    case "1":
      if (viewerSession.viewMode === "single") {
        singleImageController.actualSize();
      }
      break;
    case "r":
    case "R":
      if (viewerSession.viewMode === "single") singleImageController.rotate();
      break;
    case "h":
    case "H":
      if (viewerSession.viewMode === "single") singleImageController.flipHorizontal();
      break;
    case "v":
    case "V":
      if (viewerSession.viewMode === "single") singleImageController.flipVertical();
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
gridSort.addEventListener("click", () => gridController.toggleSort());
gridSize.addEventListener("click", () => gridController.cycleSize());
btnProps.addEventListener("click", toggleProps);
btnRotate.addEventListener("click", () => singleImageController.rotate());
btnFlipH.addEventListener("click", () => singleImageController.flipHorizontal());
btnFlipV.addEventListener("click", () => singleImageController.flipVertical());
btnResetTransform.addEventListener("click", () => {
  singleImageController.reset();
  refreshStatus();
});
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
bindWindowChrome();

// ---------- 自定义右键菜单（接管 WebView 默认菜单） ----------
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

createContextMenuController({
  grid,
  stage: imgStage,
  isSingleView: () => viewerSession.viewMode === "single",
  getImageAt: (index) => viewerSession.images[index],
  getActiveImage: () => viewerSession.images[viewerSession.activeIndex],
  onView: showSingle,
  onCopyImage: (entry) => void copyImageBitmap(entry),
  onCopyPath: (path) => void copyImagePath(path),
  translate: t,
});

// 拖放打开
bindFileDrop(dropOverlay, openFileOrFolder);

// ---------- 设置与更新 ----------
function refreshViewerTranslations() {
  gridController.refreshMenu();
  refreshStatus();
  if (viewerSession.viewMode === "single" && viewerSession.activeIndex >= 0) {
    imagePropertiesController.render(viewerSession.images[viewerSession.activeIndex]);
  }
}

const settingsController = createSettingsController({
  getConfig: () => config,
  setCurrentConfig: (next) => {
    config = next;
  },
  setLanguage: setLang,
  applyTheme,
  applyI18n: () => applyI18n(document),
  refreshViewerTranslations,
  translate: t,
  toast,
});
// ---------- 关于页 ----------
const aboutController = createAboutController({ toast });

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (settingsController.dismissUpdateIfOpen()) return;
  if (aboutController.closeIfOpen()) return;
  settingsController.closeIfOpen();
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
  void bindOpenImageBridge(openFileOrFolder, t, toast);
  void showStartupNotices(t, toast);
  // 记住上次的语言仅作展示；无目录状态由用户操作进入
})();

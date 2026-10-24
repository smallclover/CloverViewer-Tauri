import { createThemeController } from "./ui/theme-controller";
import "./styles.css";
import { applyI18n, setLang, t } from "./i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { createToast, playEnterAnimation } from "./ui/presentation";
import { createAboutController } from "./ui/about-controller";
import { createAppMenuController } from "./ui/app-menu-controller";
import { createShortcutDialog } from "./ui/shortcut-dialog";
import { createContextMenuController } from "./ui/context-menu-controller";
import { bindFileDrop, bindOpenImageBridge, showStartupNotices } from "./ui/app-bridges";
import { createNavigationGuard } from "./ui/navigation-guard";
import { createDirectoryLoader } from "./viewer/directory-loader";
import { bindDirectoryRefreshShortcut } from "./viewer/refresh-shortcut";
import { createPageNavigationController } from "./ui/page-navigation-controller";
import { createSettingsController } from "./ui/settings-controller";
import { createDesktopPetController } from "./ui/desktop-pet-controller";
import { initializeWindowShell } from "./ui/window-shell";
import { bindWindowChrome } from "./ui/window-chrome";
import { createGridController } from "./viewer/grid-controller";
import { createImagePixelExporter, IMAGE_EXTENSIONS } from "./viewer/image-pixels";
import { createImageSourceResolver } from "./viewer/image-source";
import { createImagePropertiesController } from "./viewer/image-properties-controller";
import { createImagePreviewStripController } from "./viewer/image-preview-strip-controller";
import { createImageShareController } from "./viewer/image-share-controller";
import { createImageOcrController } from "./viewer/image-ocr-controller";
import { createImageEditorController } from "./viewer/image-editor-controller";
import { createSingleImageController } from "./viewer/single-image-controller";
import { createSingleImagePresenter } from "./viewer/single-image-presenter";
import { createViewerSession } from "./viewer/viewer-session";
import { createViewerPanels } from "./viewer/viewer-panels";
import {
  type AppConfig,
  type ImageEntry,
  copyImageFile,
  copyText,
  fileSrc,
  formatDimensions,
  formatSize,
  getConfig,
  getActiveHotkeys,
  isLanShareActive,
  type ActiveHotkeys,
  listenExitRequested,
  quitApp,
  getImageInfo,
  getThumbnail,
  listImages,
  listenTrayAction,
  openContainingFolder,
  prepareScreenshotWindow,
  readImageData,
  readEditableImageData,
  saveEditedImage,
  startImageLanShare,
  stopLanShare,
  startCapture,
} from "./api";

// ---------- 状态 ----------
let config: AppConfig | null = null;
let activeHotkeys: ActiveHotkeys | null = null;
async function refreshActiveHotkeys() {
  activeHotkeys = await getActiveHotkeys();
  appMenu?.refresh();
}
let appMenu: ReturnType<typeof createAppMenuController> | undefined;
const viewerSession = createViewerSession();

const imageSource = createImageSourceResolver({ fileSrc, readImageData });
const imagePixels = createImagePixelExporter(readEditableImageData);
const viewerThumbnail = async (path: string, size: number) =>
  (await imagePixels(path, size)) ?? getThumbnail(path, size);

// ---------- DOM 引用 ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const emptyState = $("empty-state");
const contentHeader = $("content-header");
const gridView = $("grid-view");
const grid = $("grid");
const gridSpacer = $("grid-spacer");
const singleView = $("single-view");
const imageEditorView = $("image-editor-view");
const imgStage = $("img-stage");
let singleImg = $<HTMLImageElement>("single-img");
const propsList = $("props-list");
const propsPanel = $("props-panel");
const propsClose = $<HTMLButtonElement>("props-close");
const imageSharePanel = $("image-share-panel");
const imageOcrPanel = $("image-ocr-panel");
const breadcrumb = $("breadcrumb");
const gridMenu = $("grid-menu");
const gridSort = $<HTMLButtonElement>("grid-sort");
const gridSortLabel = $("grid-sort-label");
const gridSortMenu = $("grid-sort-menu");
const gridSize = $<HTMLButtonElement>("grid-size");
const gridSizeLabel = $("grid-size-label");
const gridSizeMenu = $("grid-size-menu");
const gridDensity = $<HTMLInputElement>("grid-density");
const gridDensityControl = $("grid-density-control");
const gridCount = $("grid-count");
const statusLeft = $("status-left");
const statusRight = $("status-right");
const imagePreviewStrip = $("image-preview-strip");
const navPrev = $<HTMLButtonElement>("nav-prev");
const navNext = $<HTMLButtonElement>("nav-next");
const dropOverlay = $("drop-overlay");
const toastEl = $("toast");

const toast = createToast(toastEl);
const desktopPetController = createDesktopPetController({
  status: $("pet-loading-status"),
  statusText: $("pet-loading-status-text"),
  getConfig: () => config,
  setCurrentConfig: (next) => {
    config = next;
    $<HTMLInputElement>("set-desktop-pet").checked = next.desktop_pet_enabled;
  },
  translate: t,
  toast,
});
const singleImageController = createSingleImageController({
  stage: imgStage,
  getImage: () => singleImg,
  isActive: () => viewerSession.viewMode === "single",
  getZoomSensitivity: () => config?.zoom_sensitivity ?? 1,
  onChange: refreshStatus,
  onTransform: () => imageOcrController.updateOverlay(),
  canPan: (event) => imageOcrController.canPan(event),
  allowFitPan: () => imageOcrController.allowFitPan(),
});
const singleImagePresenter = createSingleImagePresenter({
  getImage: () => singleImg,
  sourceFor: imageSource.for,
  isActive: () => viewerSession.viewMode === "single",
  onCommit: (image) => {
    singleImg = image;
    const entry = viewerSession.images[viewerSession.activeIndex];
    if (entry?.path === image.dataset.imagePath) {
      entry.width = image.naturalWidth;
      entry.height = image.naturalHeight;
    }
    singleImageController.reset();
    refreshStatus();
  },
  onError: (error) => {
    const displayedIndex = viewerSession.images.findIndex(
      (entry) => entry.path === singleImg.dataset.imagePath,
    );
    if (displayedIndex >= 0) {
      viewerSession.activeIndex = displayedIndex;
      gridController.updateActive();
      updateNavButtons();
      imagePanels.refreshProperties();
      applyImagePreviewStripState();
      pageNavigation.replaceCurrentImage(displayedIndex);
      refreshStatus();
    }
    toast(t("toast.openFailed", { msg: String(error) }), "error");
  },
});
const imagePropertiesController = createImagePropertiesController({
  list: propsList,
  getImageInfo,
  formatDimensions,
  formatSize,
  openContainingFolder,
  onOpenFolderError: (error) => toast(t("toast.openFolderFailed", { msg: String(error) }), "error"),
  translate: t,
});
const imageShareController = createImageShareController({
  panel: imageSharePanel,
  isLanShareActive,
  startLanShare: async (path) => startImageLanShare(path, await imagePixels(path)),
  copyText,
  stopLanShare,
  translate: t,
  onClose: () => closeImageShare(),
});
const imageOcrController = createImageOcrController({
  panel: imageOcrPanel,
  stage: imgStage,
  getImage: () => singleImg,
  getEntry: (path) => viewerSession.images.find((entry) => entry.path === path),
  isActive: () =>
    viewerSession.viewMode === "single" &&
    !imageEditor.isOpen() &&
    !settingsController.isOpen() &&
    !aboutController.isOpen(),
  onLayout: () => singleImageController.applyTransform(),
  panImage: (x, y) => singleImageController.panBy(x, y),
  copyText,
  translate: t,
  toast,
  onClose: () => closeImageOcr(),
});
new ResizeObserver(() => {
  if (viewerSession.viewMode === "single") singleImageController.applyTransform();
}).observe(imgStage);
const imageEditor = createImageEditorController({
  root: imageEditorView,
  getEditableSource: readEditableImageData,
  saveImage: saveEditedImage,
  translate: t,
  onClose: leaveEdit,
  onSaved: (path) => {
    const directory = viewerSession.currentDir;
    const normalized = path.replace(/\\/g, "/");
    const parent = normalized.slice(0, normalized.lastIndexOf("/"));
    if (
      directory &&
      parent.toLowerCase() === directory.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase()
    )
      void directoryLoader.refresh(directory);
  },
  toast,
});

// ---------- 主题 ----------
const themeController = createThemeController();
const applyTheme = themeController.set;
window.addEventListener("beforeunload", themeController.dispose);

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
  breadcrumb.append(icon, name);
}

// ---------- 目录加载 ----------
const navigationGuard = createNavigationGuard(() =>
  imageEditor.isOpen() ? imageEditor.requestLeave() : Promise.resolve(true),
);
const directoryLoader = createDirectoryLoader({
  load: listImages,
  commit: (dir, entries, refresh) => {
    if (refresh && viewerSession.currentDir === dir) {
      const previous = viewerSession.images.map((image) => image.path);
      const oldIndex = viewerSession.activeIndex;
      const scrollTop = gridView.scrollTop;
      gridController.sortCurrentImages(entries);
      if (viewerSession.viewMode === "single" && viewerSession.activeIndex < 0 && entries.length)
        viewerSession.activeIndex = Math.min(Math.max(oldIndex, 0), entries.length - 1);
      pageNavigation.remapImages(
        previous,
        viewerSession.images.map((image) => image.path),
      );
      imageSource.clear();
      singleImagePresenter.clear();
      imagePreviewStripController.clear();
      gridController.clearThumbnails();
      if (viewerSession.viewMode === "grid") {
        gridController.renderGrid();
        gridView.scrollTop = scrollTop;
      } else if (viewerSession.viewMode === "single") {
        if (viewerSession.activeIndex >= 0) {
          pageNavigation.replaceCurrentImage(viewerSession.activeIndex);
          showSingle(viewerSession.activeIndex);
        } else pageNavigation.resetViewer();
      }
      refreshStatus();
      return;
    }
    viewerSession.setDirectory(dir, entries);
    gridController.sortCurrentImages();
    imageSource.clear();
    singleImagePresenter.clear();
    imagePreviewStripController.clear();
    gridController.clearThumbnails();
    renderBreadcrumb();
    if (entries.length === 0) {
      toast(t("toast.noImages"));
    }
    pageNavigation.resetViewer();
    refreshStatus();
  },
  onError: (error) => toast(t("toast.openFailed", { msg: String(error) }), "error"),
});
async function openDirectory(dir: string) {
  let opened = false;
  await navigationGuard.run(async () => {
    imageEditor.cancelPendingOpen();
    opened = await directoryLoader.open(dir);
  });
  return opened;
}

async function openFileOrFolder(path: string) {
  // 拖入的可能是文件（取其所在目录）或目录
  const normalized = path.replace(/\\/g, "/");
  const isFile = /\.(png|jpe?g|bmp|gif|webp|tiff?|avif)$/i.test(normalized);
  if (!isFile) {
    return openDirectory(normalized);
  }
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return;
  const dir =
    normalized.slice(0, lastSlash) + (lastSlash === 2 && normalized[1] === ":" ? "/" : "");
  if (!(await openDirectory(dir))) return false;
  const idx = viewerSession.images.findIndex(
    (img) => img.path.replace(/\\/g, "/").toLowerCase() === normalized.toLowerCase(),
  );
  if (idx < 0) return false;
  openImageDetails(idx);
  return true;
}

// ---------- 网格视图（窗口化虚拟滚动） ----------
const gridController = createGridController({
  gridView,
  grid,
  spacer: gridSpacer,
  sortButton: gridSort,
  sortLabel: gridSortLabel,
  sortMenu: gridSortMenu,
  sizeButton: gridSize,
  sizeLabel: gridSizeLabel,
  sizeMenu: gridSizeMenu,
  sizeSlider: gridDensity,
  session: viewerSession,
  imageSource,
  getThumbnail: viewerThumbnail,
  translate: t,
  onSelect: openImageDetails,
});
const imagePreviewStripController = createImagePreviewStripController({
  strip: imagePreviewStrip,
  toggle: $<HTMLButtonElement>("image-preview-toggle"),
  session: viewerSession,
  imageSource,
  getThumbnail: viewerThumbnail,
  onSelect: openImageDetails,
  onToggle: () =>
    settingsController.setImagePreviewStripEnabled(!(config?.image_preview_strip_enabled ?? true)),
  translate: t,
});

function applyImagePreviewStripState() {
  const visible = config?.image_preview_strip_enabled ?? true;
  imagePreviewStripController.setVisible(visible);
  if (visible && viewerSession.viewMode === "single" && viewerSession.activeIndex >= 0) {
    imagePreviewStripController.render(viewerSession.activeIndex);
  }
  singleImageController.applyTransform();
  refreshStatus();
}

function showGrid() {
  imageEditor.cancelPendingOpen();
  singleImagePresenter.cancel();
  imagePanels.closeTransient();
  viewerSession.viewMode = "grid";
  const hasImages = viewerSession.images.length > 0;
  const hasDirectory = !!viewerSession.currentDir;
  // 初始空态不需要这条上下文栏；一旦用户选定目录（即使目录里没有图片）就恢复。
  contentHeader.classList.toggle("hidden", !hasDirectory && !hasImages);
  emptyState.classList.toggle("hidden", hasImages || hasDirectory);
  gridView.classList.toggle("hidden", !hasImages);
  singleView.classList.add("hidden");
  imageEditorView.classList.add("hidden");
  gridMenu.classList.toggle("hidden", !hasImages);
  gridDensityControl.classList.toggle("hidden", !hasImages);
  breadcrumb.classList.remove("hidden");
  gridCount.classList.remove("hidden");
  gridController.refreshMenu();
  gridController.renderGrid();
  playEnterAnimation(gridView);
  updateNavButtons();
  refreshStatus();
}

const imagePanels = createViewerPanels({
  session: viewerSession,
  properties: { panel: propsPanel, render: imagePropertiesController.render },
  share: {
    panel: imageSharePanel,
    open: imageShareController.open,
    close: imageShareController.close,
  },
  ocr: imageOcrController,
  showImage: openImageDetails,
  onLayout: () => {
    singleImageController.applyTransform();
    refreshStatus();
  },
});
const {
  applyProperties: applyPropsState,
  closeProperties: closeProps,
  closeShare: closeImageShare,
  closeOcr: closeImageOcr,
  openShare: openImageShare,
  openOcr: openImageOcr,
} = imagePanels;

// ---------- 单图视图 ----------
function showSingle(index: number) {
  if (index < 0 || index >= viewerSession.images.length) return;
  imageEditor.cancelPendingOpen();
  const entering = viewerSession.viewMode !== "single" || singleView.classList.contains("hidden");
  gridController.pauseThumbnails();
  viewerSession.activeIndex = index;
  imagePanels.closeTransient();
  viewerSession.viewMode = "single";
  contentHeader.classList.add("hidden");
  emptyState.classList.add("hidden");
  gridView.classList.add("hidden");
  singleView.classList.remove("hidden");
  imageEditorView.classList.add("hidden");
  if (entering) playEnterAnimation(singleView);
  gridMenu.classList.add("hidden");
  gridDensityControl.classList.add("hidden");
  breadcrumb.classList.add("hidden");
  gridCount.classList.add("hidden");
  gridController.updateActive();
  applyPropsState();
  updateNavButtons();

  const entry = viewerSession.images[index];
  const neighbors = [viewerSession.images[index - 1], viewerSession.images[index + 1]].filter(
    (image): image is ImageEntry => !!image,
  );
  void singleImagePresenter.show(entry, neighbors);
  applyImagePreviewStripState();
  refreshStatus();
}

/** 从网格等浏览界面打开单图详情，并压入标题栏历史，使「后退」能回到网格。 */
function openImageDetails(index: number) {
  if (index < 0 || index >= viewerSession.images.length) return;
  pageNavigation.showImage(index);
}

async function enterEdit(entry = viewerSession.images[viewerSession.activeIndex]) {
  if (!entry) return;
  directoryLoader.cancel();
  try {
    const opened = await imageEditor.open(entry, () => {
      singleImagePresenter.cancel();
      gridController.pauseThumbnails();
      const index = viewerSession.images.findIndex((image) => image.path === entry.path);
      if (index >= 0) viewerSession.activeIndex = index;
      imagePanels.closeAll();
      viewerSession.viewMode = "edit";
      for (const element of [
        contentHeader,
        emptyState,
        gridView,
        singleView,
        gridMenu,
        gridDensityControl,
        breadcrumb,
        gridCount,
      ])
        element.classList.add("hidden");
    });
    if (opened) refreshStatus();
  } catch (error) {
    toast(t("toast.openFailed", { msg: String(error) }), "error");
  }
}

function leaveEdit() {
  if (!viewerSession.images[viewerSession.activeIndex]) {
    pageNavigation.resetViewer();
    return;
  }
  viewerSession.viewMode = "single";
  showSingle(viewerSession.activeIndex);
}

// 刷新状态栏文案（语言切换时也会调用）
function refreshStatus() {
  imagePreviewStripController.setAvailable(
    viewerSession.viewMode === "single" && viewerSession.activeIndex >= 0,
  );
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
  } else if (viewerSession.viewMode === "edit") {
    statusLeft.textContent = t("editor.title");
    statusRight.textContent = "";
    gridCount.classList.add("hidden");
  } else if (viewerSession.currentDir) {
    statusLeft.textContent = "";
    statusRight.textContent = "";
    gridCount.textContent = t("status.imageCount", { count: viewerSession.images.length });
    gridCount.classList.remove("hidden");
  } else {
    statusLeft.textContent = t("status.ready");
    statusRight.textContent = "";
    gridCount.classList.add("hidden");
  }
  statusLeft.title = statusLeft.textContent ?? "";
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
  pageNavigation.replaceCurrentImage(next);
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
  if (e.defaultPrevented || imageEditor.isOpen()) return;
  if (e.ctrlKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    if (e.shiftKey) void pickImage();
    else void pickFolder();
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === "e") {
    e.preventDefault();
    void enterEdit();
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
      // Esc 由下面的统一导航监听消费。
      break;
    case "Tab":
      e.preventDefault();
      if (viewerSession.viewMode === "single") pageNavigation.back();
      else if (viewerSession.images.length > 0) {
        openImageDetails(Math.max(viewerSession.activeIndex, 0));
      }
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

bindDirectoryRefreshShortcut({
  isBlocked: () =>
    imageEditor.isOpen() ||
    imageEditor.isOpening() ||
    settingsController.isOpen() ||
    aboutController.isOpen(),
  refresh: async () => {
    if (viewerSession.currentDir) await directoryLoader.refresh(viewerSession.currentDir);
  },
});

// ---------- 文件夹选择 ----------
async function pickFolder() {
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected === "string") {
    await openDirectory(selected);
  }
}

async function pickImage() {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: t("menu.imageFiles"),
        extensions: IMAGE_EXTENSIONS,
      },
    ],
  });
  if (typeof selected === "string") await openFileOrFolder(selected);
}

// ---------- 事件绑定 ----------
$("btn-open").addEventListener("click", () => void pickFolder());
propsClose.addEventListener("click", closeProps);
const closeGridMenus = () => {
  gridSortMenu.classList.add("hidden");
  gridSizeMenu.classList.add("hidden");
  gridSort.ariaExpanded = "false";
  gridSize.ariaExpanded = "false";
};
const toggleGridMenu = (menu: HTMLElement, button: HTMLButtonElement) => {
  const willOpen = menu.classList.contains("hidden");
  closeGridMenus();
  menu.classList.toggle("hidden", !willOpen);
  button.ariaExpanded = String(willOpen);
};
gridSort.addEventListener("click", () => toggleGridMenu(gridSortMenu, gridSort));
gridSize.addEventListener("click", () => toggleGridMenu(gridSizeMenu, gridSize));
gridSortMenu.querySelectorAll<HTMLButtonElement>("[data-sort-order]").forEach((button) => {
  button.addEventListener("click", () => {
    gridController.setNewestFirst(button.dataset.sortOrder === "newest");
    closeGridMenus();
  });
});
gridSizeMenu.querySelectorAll<HTMLButtonElement>("[data-size-index]").forEach((button) => {
  button.addEventListener("click", () => {
    gridController.setThumbSize(Number(button.dataset.sizeIndex));
    closeGridMenus();
  });
});
document.addEventListener("mousedown", (event) => {
  if (!(event.target as HTMLElement).closest("#grid-menu")) closeGridMenus();
});
// 单图切图按钮：点击切换 + 阻止 mousedown 冒泡，避免误触发拖拽平移
navPrev.addEventListener("mousedown", (e) => e.stopPropagation());
navNext.addEventListener("mousedown", (e) => e.stopPropagation());
navPrev.addEventListener("click", () => navigate(-1));
navNext.addEventListener("click", () => navigate(1));

// ---------- 无边框窗口控制 ----------
bindWindowChrome(async () => {
  if (config?.minimize_on_close) return false;
  return navigationGuard.run(() => {});
});

// ---------- 自定义右键菜单（接管 WebView 默认菜单） ----------
// 复制图片走原生剪贴板，避免 Windows WebView2 对 ClipboardItem 图片支持不完整。
// 滚动截图的长图也在本窗口打开，与网格/单图共用这条复制路径。
async function copyImageBitmap(entry: ImageEntry) {
  try {
    await copyImageFile(entry.path, await imagePixels(entry.path));
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
  onView: openImageDetails,
  onCopyImage: (entry) => void copyImageBitmap(entry),
  onCopyPath: (path) => void copyImagePath(path),
  onShare: openImageShare,
  hasOcrResult: imageOcrController.hasResult,
  onOcrResult: openImageOcr,
  onEdit: (entry) => void enterEdit(entry),
  onProperties: imagePanels.openProperties,
  translate: t,
});

// 拖放打开
bindFileDrop(dropOverlay, openFileOrFolder);

// ---------- 设置与更新 ----------
function refreshViewerTranslations() {
  appMenu?.refresh();
  gridController.refreshMenu();
  refreshStatus();
  imagePanels.refreshProperties();
  imageEditor.refreshTranslations();
  imageOcrController.refreshTranslations();
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
  refreshImagePreviewStrip: applyImagePreviewStripState,
  refreshActiveHotkeys,
  setDesktopPetEnabled: desktopPetController.setEnabled,
  translate: t,
  toast,
});
// ---------- 关于页 ----------
const aboutController = createAboutController({ toast });
const pageNavigation = createPageNavigationController({
  beforeNavigate: (action) => {
    void navigationGuard.run(action);
  },
  showViewer: (imageIndex) => {
    aboutController.close();
    settingsController.close();
    if (imageIndex === null) showGrid();
    else showSingle(imageIndex);
  },
  showSettings: () => {
    imageEditor.cancelPendingOpen();
    singleImagePresenter.cancel();
    aboutController.close();
    settingsController.open();
  },
  showAbout: () => {
    imageEditor.cancelPendingOpen();
    singleImagePresenter.cancel();
    settingsController.close();
    aboutController.open();
  },
});

document.getElementById("btn-settings")?.addEventListener("click", () => {
  void navigationGuard.run(() => pageNavigation.showSettings());
});
document.getElementById("btn-about")?.addEventListener("click", () => {
  void navigationGuard.run(() => pageNavigation.showAbout());
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (settingsController.dismissUpdateIfOpen()) {
    event.preventDefault();
    return;
  }
  if (imageEditor.isOpen()) return;
  if (pageNavigation.back()) event.preventDefault();
});

const shortcuts = createShortcutDialog({
  translate: t,
  onOpen: () => appMenu?.close(),
  getHotkeys: () => ({
    screenshot: activeHotkeys
      ? (activeHotkeys.show_screenshot ?? "—")
      : (config?.hotkeys.show_screenshot ?? "Alt+S"),
    scroll: activeHotkeys
      ? (activeHotkeys.scroll_capture ?? "—")
      : (config?.hotkeys.scroll_capture ?? "Alt+Shift+S"),
  }),
});
const openSettingsTab = (tab: string) => {
  pageNavigation.showSettings();
  settingsController.selectTab(tab);
};
appMenu = createAppMenuController({
  toolbar: $("toolbar"),
  translate: t,
  getState: () => ({
    edit: imageEditor.isOpen() || imageEditor.isOpening(),
    screenshotHotkey: activeHotkeys
      ? (activeHotkeys.show_screenshot ?? "—")
      : (config?.hotkeys.show_screenshot ?? "Alt+S"),
    scrollHotkey: activeHotkeys
      ? (activeHotkeys.scroll_capture ?? "—")
      : (config?.hotkeys.scroll_capture ?? "Alt+Shift+S"),
  }),
  run: async (action) => {
    switch (action) {
      case "open-image":
        await pickImage();
        break;
      case "screenshot":
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => window.setTimeout(resolve, 0)),
        );
        await startCapture();
        break;
      case "scroll-screenshot":
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => window.setTimeout(resolve, 0)),
        );
        await startCapture(true);
        break;
      case "capture-settings":
        openSettingsTab("capture");
        break;
      case "shortcuts":
        shortcuts.open();
        break;
      case "update":
        openSettingsTab("general");
        await settingsController.checkForUpdate();
        break;
    }
  },
  onError: (error) => toast(t("menu.actionFailed", { msg: String(error) }), "error"),
});

// ---------- 启动 ----------
(async () => {
  await listenExitRequested(() => {
    void navigationGuard.run(quitApp);
  });
  await listenTrayAction((action) => {
    if (action.action === "settings") {
      if (imageEditor.isOpen()) toast(t("menu.finishEditing"));
      else openSettingsTab("general");
    }
  });
  try {
    config = await getConfig();
    await refreshActiveHotkeys();
    setLang(config.language);
    applyTheme(config.theme);
  } catch (e) {
    console.error("读取配置失败", e);
    applyTheme("system");
  }
  applyI18n(document);
  const shellError = (error: unknown) =>
    toast(t("toast.windowDecorationFailed", { msg: String(error) }), "error");
  void initializeWindowShell(shellError).catch(shellError);
  refreshStatus();
  // 预热推迟到启动之后：--startup 隐藏查看器时定时器照样会跑，
  // 而 requestAnimationFrame 在那里会停摆，导致首次托盘截图仍是冷启动。
  window.setTimeout(() => {
    void prepareScreenshotWindow().catch((error) => {
      console.warn("Preparing screenshot window failed; will retry on capture", error);
    });
  }, 150);
  if (config?.desktop_pet_enabled) {
    void desktopPetController.setEnabled(true).catch((error) => {
      toast(t("toast.desktopPetFailed", { msg: String(error) }), "error");
    });
  }
  void bindOpenImageBridge(
    async (payload) => {
      if ((await openFileOrFolder(payload.path)) === false) return false;
      if (typeof payload.ocr_text !== "string" && !payload.ocr_document) return;
      const normalized = payload.path.replace(/\\/g, "/").toLowerCase();
      const entry = viewerSession.images.find(
        (image) => image.path.replace(/\\/g, "/").toLowerCase() === normalized,
      );
      if (!entry) throw new Error(t("toast.openFailed", { msg: payload.path }));
      imageOcrController.setResult(
        entry.path,
        payload.ocr_document ?? payload.ocr_text ?? "",
        entry,
      );
      openImageOcr(entry);
      if (!(await singleImagePresenter.whenReady())) {
        throw new Error(t("toast.openFailed", { msg: payload.path }));
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    t,
    toast,
  );
  void showStartupNotices(t, toast);
})();

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";

export type { DownloadEvent };
export type AppUpdate = Pick<Update, "version" | "body" | "download" | "install" | "close">;
export const checkAppUpdate = (timeout: number): Promise<AppUpdate | null> => check({ timeout });

export interface ImageEntry {
  path: string;
  name: string;
  size: number;
  modified: string;
  width: number;
  height: number;
  /** false = WebView 不支持，需调用 read_image_data 解码兜底（如 tiff） */
  web_supported: boolean;
}

export interface HotkeysConfig {
  show_screenshot: string;
  copy_color: string;
  /** 滚动截图专属热键：按下直接进「滚动截图待框选」态（默认 Alt+Shift+S） */
  scroll_capture: string;
}

export interface AppConfig {
  language: "Zh" | "En" | "Ja";
  theme: "dark" | "light" | "system";
  /** 主界面和截图界面的缩放百分比，默认 100%。 */
  ui_scale: 100 | 110 | 125 | 150;
  zoom_sensitivity: number;
  /** 单图查看时，是否显示相邻图片的预览条。 */
  image_preview_strip_enabled: boolean;
  hotkeys: HotkeysConfig;
  minimize_on_close: boolean;
  magnifier_enabled: boolean;
  /** 默认关闭；开启后滚动截图面板才显示“自动滚动（试验）”。 */
  experimental_auto_scroll: boolean;
  screenshot_hides_main_window: boolean;
  /** 是否显示独立透明窗口中的桌面小宠物。 */
  desktop_pet_enabled: boolean;
  /** 桌宠相对于 360×540 标准窗口的缩放百分比（60–200）。 */
  desktop_pet_scale: number;
  launch_on_startup: boolean;
  /** 0 = 不自动清理；其它值为临时截图最长保留小时数。 */
  cache_cleanup_after_hours: number;
  /** 局域网分享的默认有效期（秒）。 */
  lan_share_duration_seconds: number;
  /** 0 = 有效期内不限次数；1 = 首次下载后失效。 */
  lan_share_download_limit: number;
  window_pos: [number, number] | null;
  window_size: [number, number] | null;
}

export const getConfig = () => invoke<AppConfig>("get_config");

export const setConfig = (config: AppConfig) => invoke<void>("set_config", { config });

/** 显示或隐藏桌面小宠物，并把偏好写入应用配置。 */
export const setDesktopPetEnabled = (enabled: boolean) =>
  invoke<void>("set_desktop_pet_enabled", { enabled });

/** 保存桌宠缩放比例，并在桌宠已创建时立即调整窗口。 */
export const setDesktopPetScale = (scale: number) =>
  invoke<void>("set_desktop_pet_scale", { scale });

/** 当前系统鼠标的虚拟桌面物理坐标；桌宠用它驱动视线跟随。 */
export const getDesktopPetCursorPosition = () =>
  invoke<{ x: number; y: number } | null>("get_desktop_pet_cursor_position");

export interface DesktopPetMenuLabels {
  screenshot: string;
  scrollScreenshot: string;
  mainWindow: string;
  quit: string;
}

/** 在桌宠窗口的右键位置弹出由 Rust 直接处理点击事件的原生菜单。 */
export const showDesktopPetMenu = (labels: DesktopPetMenuLabels, x: number, y: number) =>
  invoke<void>("show_desktop_pet_menu", { labels, x, y });

export interface DesktopPetLoadStatus {
  state: "started" | "ready" | "failed";
  sessionId: string;
}

/** 桌宠窗口向主窗口报告实际的模型加载状态。 */
export const reportDesktopPetLoadStatus = (status: DesktopPetLoadStatus) =>
  emitTo("main", "desktop-pet-load-status", status);

export const listenDesktopPetLoadStatus = (
  handler: (status: DesktopPetLoadStatus) => void,
): Promise<UnlistenFn> =>
  listen<DesktopPetLoadStatus>("desktop-pet-load-status", (event) => handler(event.payload));

/** 请求已运行的桌宠窗口重放一次当前加载状态（主窗口挂载时补齐状态用）。 */
export const requestDesktopPetLoadStatus = () =>
  emitTo("desktop-pet", "desktop-pet-status-request", {});

export const listenDesktopPetStatusRequest = (handler: () => void): Promise<UnlistenFn> =>
  listen("desktop-pet-status-request", handler);

export interface CacheSummary {
  files: number;
  bytes: number;
}

export interface CacheCleanupResult extends CacheSummary {}

export const getCacheSummary = () => invoke<CacheSummary>("get_cache_summary");

export const clearTempCache = (olderThanHours: number) =>
  invoke<CacheCleanupResult>("clear_temp_cache", { olderThanHours });

export const setLaunchOnStartup = (enabled: boolean) =>
  invoke<void>("set_launch_on_startup", { enabled });

export const setShowScreenshotHotkey = (hotkey: string) =>
  invoke<void>("set_show_screenshot_hotkey", { hotkey });

export const setScrollCaptureHotkey = (hotkey: string) =>
  invoke<void>("set_scroll_capture_hotkey", { hotkey });

export const listImages = (dir: string) => invoke<ImageEntry[]>("list_images", { dir });

export const readImageData = (path: string) => invoke<string>("read_image_data", { path });

/** 把本地图片读成同源 data URL，满足 Canvas 绘制与导出的同源要求。 */
export const readEditableImageData = (path: string) =>
  invoke<string>("read_editable_image_data", { path });

export const getThumbnail = (path: string, size: number) =>
  invoke<string>("get_thumbnail", { path, size });

export interface ExifInfo {
  datetime: string;
  make: string;
  model: string;
  iso: string;
  f_number: string;
  exposure_time: string;
  focal_length: string;
  lens_model: string;
}

export const getImageInfo = (path: string) => invoke<ExifInfo>("get_image_info", { path });

export interface ScreenData {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotData {
  /** 标识本次截图的那批 RGBA 帧（取帧与关闭都靠它校验，避免领错会话）。 */
  capture_id: number;
  min_x: number;
  min_y: number;
  total_width: number;
  total_height: number;
  screens: ScreenData[];
  monitor_info: MonitorInfo[];
  /** 截图打开时的鼠标虚拟桌面物理坐标，用于将普通截图提示放到当前屏。 */
  cursor: { x: number; y: number } | null;
}

export interface MonitorInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  img_width: number;
  img_height: number;
  scale_factor: number;
  is_primary: boolean;
}

export const getScreenshotData = () => invoke<ScreenshotData | null>("get_screenshot_data");

/** 直接取原始 RGBA 字节（自上而下，每像素 4 字节），不走 JSON/Base64。 */
export const getScreenshotFrame = (captureId: number, screenIndex: number) =>
  invoke<ArrayBuffer | number[]>("get_screenshot_frame", { captureId, screenIndex });

/** 提前备好隐藏的截图 WebView：不抓屏、不改动焦点。 */
export const prepareScreenshotWindow = () => invoke<void>("prepare_screenshot_window");

/** 前端把截图渲染完成后通知后端：此时才显示截图窗口（避免冷启动白屏/锁屏） */
export const screenshotUiReady = (captureId: number) =>
  invoke<boolean>("screenshot_ui_ready", { captureId });

/** 本次是否以「滚动截图模式」启动覆盖窗（取走即清，一次性） */
export const takeScrollStartMode = () => invoke<boolean>("take_scroll_start_mode");

export const closeScreenshot = (completed = false, captureId?: number) =>
  invoke<void>("close_screenshot", { completed, captureId });

export const finishScreenshot = (
  action: "save" | "clipboard" | "open",
  png: string,
  ocrText?: string,
  deferClose = false,
) =>
  invoke<void>("finish_screenshot", {
    req: { action, png, ocr_text: ocrText, defer_close: deferClose },
  });

export interface OpenImagePayload {
  path: string;
  /** Rust 把缺失的 OCR 文本序列化为 null；滚动截图则完全不传该字段。 */
  ocr_text?: string | null;
}

export const listenOpenImage = (
  handler: (payload: OpenImagePayload) => void,
): Promise<UnlistenFn> => listen<OpenImagePayload>("open-image", (event) => handler(event.payload));

export type EditedImageFormat = "png" | "jpeg" | "webp";

/** 用 Rust 的图像编码器把 Canvas 结果写成用户选定的格式，存到指定路径。 */
export const saveEditedImage = (path: string, png: string, format: EditedImageFormat) =>
  invoke<void>("save_edited_image", { path, png, format });

export interface LanShareInfo {
  url: string;
  qr_code: string;
  expires_in_seconds: number;
  download_limit: number;
}

/** 开启临时的、带 token 校验的 HTTP 分享，仅同一局域网内的设备可访问。 */
export const startLanShare = (png: string) => invoke<LanShareInfo>("start_lan_share", { png });

/** 把查看器当前图片转成浏览器可直接显示的 JPEG 预览再分享。 */
export const startImageLanShare = (path: string) =>
  invoke<LanShareInfo>("start_image_lan_share", { path });

export const stopLanShare = () => invoke<void>("stop_lan_share");

export const copyText = (text: string) => invoke<void>("copy_text", { text });

/** 原生写入图片剪贴板，避开 WebView2 对 ClipboardItem 图片的兼容性限制。 */
export const copyImageFile = (path: string) => invoke<void>("copy_image_file", { path });

/** 关于页展示的应用信息（版本/标识/Tauri 版本/平台，均取自运行时真实值） */
export interface AppInfo {
  version: string;
  identifier: string;
  tauri: string;
  os: string;
  arch: string;
}

export const getAppInfo = () => invoke<AppInfo>("get_app_info");

/** 启动阶段的后端提示（热键冲突等），前端启动后一次性取走 */
export interface StartupNotice {
  /** "hotkey_fallback" = 想用的组合被占用、已临时改用别的；"hotkey_conflict" = 完全没注册上 */
  kind: string;
  wanted: string | null;
  used: string | null;
}

export const takeStartupNotices = () => invoke<StartupNotice[]>("take_startup_notices");

/** 用系统默认浏览器打开 https 链接（后端限制只放行 https://） */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

/** 在文件管理器中打开图片所在的文件夹。 */
export const openContainingFolder = (path: string) =>
  invoke<void>("open_containing_folder", { path });

export const ocrImage = (png: string) => invoke<string>("ocr_image", { png });

/** 物理坐标 (x, y) 处的顶层窗口矩形（用于绿框跟随鼠标自动框选窗口） */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const pickWindowAt = (x: number, y: number) =>
  invoke<WindowRect | null>("pick_window_at", { x, y });

// 滚动截图（长截图）

/** 滚动截图请求：x/y/w/h 是**虚拟桌面物理像素**（= 截图窗内坐标 + min_x/min_y） */
export interface ScrollCaptureRequest {
  x: number;
  y: number;
  w: number;
  h: number;
  /** manual（默认 UI）= 用户自己滚动并由程序在稳定后采帧；auto = 实验性注入滚动。 */
  mode?: "auto" | "manual";
  /** "auto"（默认，后端探针自动选注入方式）或 wheel_post / wheel_post_root / wheel_input /
   *  pagedown / vscroll */
  method?: string;
  /** 每步滚轮格数；不传则按探针标定自动定 */
  notches?: number;
  settle_timeout_ms?: number;
  poll_ms?: number;
  auto_scroll_top?: boolean;
  max_height_px?: number;
  max_frames?: number;
  focus_target?: boolean;
  /** true 表示 HUD 与捕获区重叠；后端优先排除覆盖窗，失败才整段隐藏 HUD。 */
  hide_hud_during_capture?: boolean;
  /** 自动滚动的内扩聚焦光晕；后端优先排除覆盖窗，失败时逐帧短暂隐藏光晕。 */
  hide_glow_during_capture?: boolean;
}

export interface ScrollCaptureProgress {
  /** 与后端 `ScrollCaptureProgress::stage` 一一对应（含 cancelled：用户 Esc / 点停止） */
  stage:
    | "probing"
    | "waiting"
    | "capturing"
    | "finishing"
    | "matched"
    | "low_confidence"
    | "done"
    | "partial"
    | "failed"
    | "cancelled";
  frames: number;
  width: number;
  height: number;
  method: string | null;
  message: string | null;
  /** true = 覆盖窗已临时 click-through（SendInput 注入），HUD 按钮点不到，只能按 Esc 停 */
  input_passthrough: boolean;
  /** 累积长图的缩略预览（data URL） */
  preview: string | null;
  /** 最近一帧已验证的清晰画面，HUD 使用蓝色表示可信内容。 */
  verified_preview: string | null;
  /** 当前候选画面；等待匹配时它不会写入结果。 */
  candidate_preview: string | null;
  /** 实际捕获区（虚拟桌面物理像素 x,y,w,h）；V2 与用户确认的正文选区一致。
   *  前端按它挖空覆盖窗，避免把自身遮罩写进屏幕帧。 */
  capture: [number, number, number, number] | null;
}

export interface ScrollCaptureDone {
  ok: boolean;
  width?: number;
  height?: number;
  frames?: number;
  /** 取值：high | low | partial */
  confidence?: string;
  message?: string;
}

export const startScrollCapture = (req: ScrollCaptureRequest) =>
  invoke<void>("start_scroll_capture", { req });

export const stopScrollCapture = () => invoke<void>("stop_scroll_capture");

/** 结果落地：save=存桌面（返回路径）/ clipboard=复制 / open=存临时文件并在查看器中打开 */
export const finishScrollCapture = (action: "save" | "clipboard" | "open") =>
  invoke<string | null>("finish_scroll_capture", { action });

export const discardScrollCapture = () => invoke<void>("discard_scroll_capture");

export const scrollCaptureProgress = () =>
  invoke<ScrollCaptureProgress | null>("scroll_capture_progress");

/** 会话是否在跑：窗口复用打开时用它恢复「后端仍在捕获」的界面状态 */
export const scrollCaptureRunning = () => invoke<boolean>("scroll_capture_running");

/** 汇报「HUD 是否压在捕获区上」：重叠时后端会让 HUD 在整个采集会话中保持隐藏，
 *  整屏 / 整窗选区没有安全空地时用作最后一道保险。 */
export const setScrollHudSafe = (overlap: boolean) =>
  invoke<void>("set_scroll_hud_safe", { overlap });

export const hasScrollCaptureResult = () => invoke<boolean>("has_scroll_capture_result");

/** 本地文件 → asset protocol URL */
export const fileSrc = convertFileSrc;

export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDimensions(w: number, h: number): string {
  if (w === 0 || h === 0) return "—";
  return `${w} × ${h}`;
}

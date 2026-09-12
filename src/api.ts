import { invoke, convertFileSrc } from "@tauri-apps/api/core";

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
  zoom_sensitivity: number;
  hotkeys: HotkeysConfig;
  minimize_on_close: boolean;
  magnifier_enabled: boolean;
  screenshot_hides_main_window: boolean;
  launch_on_startup: boolean;
  window_pos: [number, number] | null;
  window_size: [number, number] | null;
}

export const getConfig = () => invoke<AppConfig>("get_config");

export const setConfig = (config: AppConfig) =>
  invoke<void>("set_config", { config });

export const setLaunchOnStartup = (enabled: boolean) =>
  invoke<void>("set_launch_on_startup", { enabled });

export const setShowScreenshotHotkey = (hotkey: string) =>
  invoke<void>("set_show_screenshot_hotkey", { hotkey });

export const setScrollCaptureHotkey = (hotkey: string) =>
  invoke<void>("set_scroll_capture_hotkey", { hotkey });

export const listImages = (dir: string) =>
  invoke<ImageEntry[]>("list_images", { dir });

export const readImageData = (path: string) =>
  invoke<string>("read_image_data", { path });

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

export const getImageInfo = (path: string) =>
  invoke<ExifInfo>("get_image_info", { path });

export interface ScreenData {
  x: number;
  y: number;
  width: number;
  height: number;
  data_url: string;
}

export interface ScreenshotData {
  min_x: number;
  min_y: number;
  total_width: number;
  total_height: number;
  screens: ScreenData[];
  monitor_info: MonitorInfo[];
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

export const getScreenshotData = () =>
  invoke<ScreenshotData | null>("get_screenshot_data");

/** 前端把截图渲染完成后通知后端：此时才显示截图窗口（避免冷启动白屏/锁屏） */
export const screenshotUiReady = () => invoke<void>("screenshot_ui_ready");

/** 本次是否以「滚动截图模式」启动覆盖窗（取走即清，一次性） */
export const takeScrollStartMode = () => invoke<boolean>("take_scroll_start_mode");

export const closeScreenshot = () => invoke<void>("close_screenshot");

export const finishScreenshot = (action: "save" | "clipboard", png: string) =>
  invoke<void>("finish_screenshot", { req: { action, png } });

export const copyText = (text: string) => invoke<void>("copy_text", { text });

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

export const takeStartupNotices = () =>
  invoke<StartupNotice[]>("take_startup_notices");

/** 用系统默认浏览器打开 https 链接（后端限制只放行 https://） */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

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

// ============================================================
// 滚动截图（长截图）
// ============================================================

/** 滚动截图请求：x/y/w/h 是**虚拟桌面物理像素**（= 截图窗内坐标 + min_x/min_y） */
export interface ScrollCaptureRequest {
  x: number;
  y: number;
  w: number;
  h: number;
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
}

export interface ScrollCaptureProgress {
  /** 与后端 `ScrollCaptureProgress::stage` 一一对应（含 cancelled：用户 Esc / 点停止） */
  stage:
    | "probing"
    | "capturing"
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
  /** **实际捕获区**（虚拟桌面物理像素 x,y,w,h）：可能比用户选区更高（矮选区自动补足）。
   *  前端必须按它挖空覆盖窗，否则补出来的部分会截到我们自己的压暗遮罩。 */
  capture: [number, number, number, number] | null;
}

export interface ScrollCaptureDone {
  ok: boolean;
  width?: number;
  height?: number;
  frames?: number;
  /** high | low | partial */
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

/** 汇报「HUD 是否压在捕获区上」：压在捕获区上时后端会在每次采帧前后让 HUD 临时隐藏
 *  （整屏 / 整窗选区时本屏内没有「选区之外」的空地，这是最后一道保险）。 */
export const setScrollHudSafe = (overlap: boolean) =>
  invoke<void>("set_scroll_hud_safe", { overlap });

export const hasScrollCaptureResult = () =>
  invoke<boolean>("has_scroll_capture_result");

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

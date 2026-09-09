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

export const closeScreenshot = () => invoke<void>("close_screenshot");

export const finishScreenshot = (action: "save" | "clipboard", png: string) =>
  invoke<void>("finish_screenshot", { req: { action, png } });

export const copyText = (text: string) => invoke<void>("copy_text", { text });

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

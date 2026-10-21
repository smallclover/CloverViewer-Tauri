import {
  getConfig,
  listenScreenshotRefresh,
  listenScreenshotClear,
  listenScrollCaptureProgress,
  listenScrollCaptureHud,
  listenScrollCaptureDone,
  screenshotUiReady,
  type ScrollCaptureDone,
  type ScrollCaptureHud,
  type ScrollCaptureProgress,
} from "../api";
import { createScreenshotRefreshController } from "./refresh-controller";
import type { SelectionBorderAppearance } from "./selection-overlay";

interface ScreenshotConfigTargets {
  setMagnifierEnabled: (enabled: boolean) => void;
  setSelectionBorderAppearance: (appearance: SelectionBorderAppearance) => void;
  setExperimentalAutoScrollEnabled: (enabled: boolean) => void;
  setLanguage: (language: "Zh" | "En" | "Ja") => void;
  setCopyColorHotkey: (hotkey: string) => void;
  applyTheme: (theme: "dark" | "light" | "system") => void;
  applyI18n: () => void;
  updateHelp: () => void;
}

/** 每次复用截图窗口时刷新其临时配置。 */
export async function refreshScreenshotConfig(targets: ScreenshotConfigTargets): Promise<void> {
  try {
    const config = await getConfig();
    targets.setMagnifierEnabled(config.magnifier_enabled);
    targets.setSelectionBorderAppearance(config);
    targets.setExperimentalAutoScrollEnabled(!!config.experimental_auto_scroll);
    targets.setLanguage(config.language);
    if (config.hotkeys?.copy_color) targets.setCopyColorHotkey(config.hotkeys.copy_color);
    targets.applyTheme(config.theme);
  } catch {
    // 读不到配置时沿用当前默认值。
  }
  targets.applyI18n();
  targets.updateHelp();
}

interface ScreenshotLifecycleOptions {
  refreshConfig: () => Promise<void>;
  loadScreenshot: () => Promise<number | null>;
  clearScreenshot: () => void;
  applyScrollStartMode: () => Promise<void>;
  onScrollProgress: (progress: ScrollCaptureProgress) => void;
  onScrollHud: (state: ScrollCaptureHud) => void;
  onScrollDone: (done: ScrollCaptureDone) => void;
}

/** 注册全部 Tauri 侧生命周期事件，并保证刷新顺序不变。 */
export async function startScreenshotLifecycle(options: ScreenshotLifecycleOptions): Promise<void> {
  const controller = createScreenshotRefreshController({
    ...options,
    showScreenshot: screenshotUiReady,
  });
  await listenScreenshotRefresh(controller.refresh);
  await listenScreenshotClear(controller.clear);
  await listenScrollCaptureProgress(options.onScrollProgress);
  await listenScrollCaptureHud(options.onScrollHud);
  await listenScrollCaptureDone(options.onScrollDone);
  await controller.refresh();
}

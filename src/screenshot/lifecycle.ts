import { listen } from "@tauri-apps/api/event";
import {
  getConfig,
  screenshotUiReady,
  type ScrollCaptureDone,
  type ScrollCaptureProgress,
} from "../api";
import { createScreenshotRefreshController } from "./refresh-controller";

interface ScreenshotConfigTargets {
  setMagnifierEnabled: (enabled: boolean) => void;
  setExperimentalAutoScrollEnabled: (enabled: boolean) => void;
  setLanguage: (language: "Zh" | "En" | "Ja") => void;
  setCopyColorHotkey: (hotkey: string) => void;
  applyTheme: (theme: "dark" | "light" | "system") => void;
  applyI18n: () => void;
  updateHelp: () => void;
}

/** Refreshes the ephemeral screenshot-window configuration on every reuse. */
export async function refreshScreenshotConfig(targets: ScreenshotConfigTargets): Promise<void> {
  try {
    const config = await getConfig();
    targets.setMagnifierEnabled(config.magnifier_enabled);
    targets.setExperimentalAutoScrollEnabled(!!config.experimental_auto_scroll);
    targets.setLanguage(config.language);
    if (config.hotkeys?.copy_color) targets.setCopyColorHotkey(config.hotkeys.copy_color);
    targets.applyTheme(config.theme);
  } catch {
    // Retain current defaults when config cannot be read.
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
  onScrollHud: (state: { hidden: boolean; hud?: boolean; glow?: boolean }) => void;
  onScrollDone: (done: ScrollCaptureDone) => void;
}

/** Registers all Tauri-side lifecycle events and preserves refresh ordering. */
export async function startScreenshotLifecycle(options: ScreenshotLifecycleOptions): Promise<void> {
  const controller = createScreenshotRefreshController({
    ...options,
    showScreenshot: screenshotUiReady,
  });
  await listen("screenshot-refresh", controller.refresh);
  await listen("screenshot-clear", controller.clear);
  await listen<ScrollCaptureProgress>("scroll-capture-progress", (event) =>
    options.onScrollProgress(event.payload),
  );
  await listen<{ hidden: boolean; hud?: boolean; glow?: boolean }>("scroll-capture-hud", (event) =>
    options.onScrollHud(event.payload),
  );
  await listen<ScrollCaptureDone>("scroll-capture-done", (event) =>
    options.onScrollDone(event.payload),
  );
  await controller.refresh();
}

import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import {
  setConfig,
  setLaunchOnStartup,
  setScrollCaptureHotkey,
  setShowScreenshotHotkey,
  type AppConfig,
} from "../api";
import type { Lang } from "../i18n";
import { playEnterAnimation, setAnimatedVisibility, type ToastKind } from "./presentation";

interface SettingsControllerOptions {
  getConfig: () => AppConfig | null;
  setCurrentConfig: (config: AppConfig) => void;
  setLanguage: (language: Lang) => void;
  applyTheme: (theme: AppConfig["theme"]) => void;
  applyI18n: () => void;
  refreshViewerTranslations: () => void;
  translate: (key: string, vars?: Record<string, string | number>) => string;
  toast: (message: string, kind?: ToastKind) => void;
}

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing settings element: ${id}`);
  return found as T;
};

/** Owns settings form persistence, hotkey registration, and the update dialog. */
export function createSettingsController(options: SettingsControllerOptions) {
  const overlay = element("settings-overlay");
  const button = element("btn-settings");
  const language = element<HTMLSelectElement>("set-language");
  const theme = element<HTMLSelectElement>("set-theme");
  const zoom = element<HTMLInputElement>("set-zoom");
  const zoomValue = element("set-zoom-val");
  const screenshotHotkey = element<HTMLInputElement>("set-hotkey");
  const colorHotkey = element<HTMLInputElement>("set-color-hotkey");
  const scrollHotkey = element<HTMLInputElement>("set-scroll-hotkey");
  const magnifier = element<HTMLInputElement>("set-magnifier");
  const experimentalAutoScroll = element<HTMLInputElement>("set-experimental-auto-scroll");
  const minimize = element<HTMLInputElement>("set-minimize");
  const autostart = element<HTMLInputElement>("set-autostart");
  const checkUpdateButton = element<HTMLButtonElement>("check-update");
  const updateOverlay = element("update-overlay");
  const updateVersion = element("update-version");
  const updateNotes = element("update-notes");
  const updateNow = element<HTMLButtonElement>("update-now");
  const updateLater = element<HTMLButtonElement>("update-later");
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"));
  const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-section]"));
  let checkingForUpdate = false;
  let updateResolver: ((install: boolean) => void) | undefined;

  const selectTab = (tab: string) => {
    tabs.forEach((tabButton) => {
      tabButton.classList.toggle("active", tabButton.dataset.settingsTab === tab);
    });
    sections.forEach((section) => {
      section.hidden = section.dataset.settingsSection !== tab;
      if (!section.hidden) playEnterAnimation(section, "tab-enter");
    });
  };

  const save = (partial: Partial<AppConfig>, silent = false) => {
    const current = options.getConfig();
    if (!current) return;
    const next = { ...current, ...partial };
    options.setCurrentConfig(next);
    void setConfig(next)
      .then(() => {
        if (!silent) options.toast(options.translate("toast.saved"), "success");
      })
      .catch(() => {
        if (!silent) options.toast(options.translate("toast.saveFailed"), "error");
      });
  };

  const close = () => {
    setAnimatedVisibility(overlay, false, 220);
    button.classList.remove("active");
    button.setAttribute("aria-pressed", "false");
  };
  const open = () => {
    const config = options.getConfig();
    if (!config) return;
    language.value = config.language;
    theme.value = config.theme;
    zoom.value = String(config.zoom_sensitivity);
    zoomValue.textContent = `${config.zoom_sensitivity.toFixed(1)}×`;
    screenshotHotkey.value = config.hotkeys.show_screenshot;
    colorHotkey.value = config.hotkeys.copy_color;
    scrollHotkey.value = config.hotkeys.scroll_capture || "Alt+Shift+S";
    magnifier.checked = config.magnifier_enabled;
    experimentalAutoScroll.checked = config.experimental_auto_scroll;
    minimize.checked = config.minimize_on_close;
    autostart.checked = config.launch_on_startup;
    selectTab("general");
    button.classList.add("active");
    button.setAttribute("aria-pressed", "true");
    setAnimatedVisibility(overlay, true, 220);
  };

  const dismissUpdate = (install: boolean) => {
    const resolve = updateResolver;
    if (!resolve) return false;
    updateResolver = undefined;
    setAnimatedVisibility(updateOverlay, false, 180);
    resolve(install);
    return true;
  };
  const showUpdate = (version: string, notes?: string) => {
    updateVersion.textContent = `v${version}`;
    updateNotes.dataset.hasNotes = notes ? "true" : "";
    updateNotes.textContent = notes || options.translate("update.noReleaseNotes");
    setAnimatedVisibility(updateOverlay, true, 180);
    window.requestAnimationFrame(() => updateNow.focus());
    return new Promise<boolean>((resolve) => {
      updateResolver = resolve;
    });
  };
  const checkForUpdate = async () => {
    if (checkingForUpdate) return;
    checkingForUpdate = true;
    checkUpdateButton.disabled = true;
    options.toast(options.translate("update.checking"), "info");
    try {
      const update = await check();
      if (!update) {
        options.toast(options.translate("update.latest"), "success");
        return;
      }
      if (!(await showUpdate(update.version, update.body?.trim()))) return;
      let downloaded = 0;
      let contentLength = 0;
      let lastPercent = -1;
      options.toast(options.translate("update.downloading", { percent: 0 }), "info");
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") contentLength = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            const percent = Math.min(100, Math.floor((downloaded / contentLength) * 100));
            if (percent !== lastPercent) {
              lastPercent = percent;
              options.toast(options.translate("update.downloading", { percent }), "info");
            }
          }
        }
      });
      options.toast(options.translate("update.installing"), "success");
      await relaunch();
    } catch (error) {
      console.warn("检查更新失败", error);
      options.toast(options.translate("update.failed", { msg: String(error) }), "error");
    } finally {
      checkingForUpdate = false;
      checkUpdateButton.disabled = false;
    }
  };

  button.addEventListener("click", () => {
    if (overlay.classList.contains("is-visible")) close();
    else open();
  });
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tab.dataset.settingsTab ?? "general"));
  });
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  language.addEventListener("change", () => {
    const next = language.value as Lang;
    save({ language: next });
    options.setLanguage(next);
    options.applyI18n();
    if (!updateOverlay.classList.contains("hidden") && !updateNotes.dataset.hasNotes) {
      updateNotes.textContent = options.translate("update.noReleaseNotes");
    }
    options.refreshViewerTranslations();
  });
  theme.addEventListener("change", () => {
    const next = theme.value as AppConfig["theme"];
    save({ theme: next });
    options.applyTheme(next);
  });
  zoom.addEventListener("input", () => {
    zoomValue.textContent = `${Number(zoom.value).toFixed(1)}×`;
  });
  zoom.addEventListener("change", () => save({ zoom_sensitivity: Number(zoom.value) }));
  magnifier.addEventListener("change", () => save({ magnifier_enabled: magnifier.checked }));
  experimentalAutoScroll.addEventListener("change", () =>
    save({ experimental_auto_scroll: experimentalAutoScroll.checked }),
  );
  minimize.addEventListener("change", () => save({ minimize_on_close: minimize.checked }));
  autostart.addEventListener("change", () => {
    save({ launch_on_startup: autostart.checked }, true);
    void setLaunchOnStartup(autostart.checked)
      .then(() =>
        options.toast(
          options.translate(autostart.checked ? "toast.autostartOn" : "toast.autostartOff"),
          "success",
        ),
      )
      .catch((error) => {
        autostart.checked = !autostart.checked;
        options.toast(options.translate("toast.autostartFailed", { msg: String(error) }), "error");
      });
  });
  checkUpdateButton.addEventListener("click", () => void checkForUpdate());
  updateNow.addEventListener("click", () => dismissUpdate(true));
  updateLater.addEventListener("click", () => dismissUpdate(false));
  updateOverlay.addEventListener("mousedown", (event) => {
    if (event.target === updateOverlay) dismissUpdate(false);
  });
  element("set-hotkey-apply").addEventListener("click", () => {
    const value = screenshotHotkey.value.trim();
    if (!value) {
      options.toast(options.translate("toast.hotkeyEmpty"));
      return;
    }
    void setShowScreenshotHotkey(value)
      .then(() => {
        const current = options.getConfig();
        if (current)
          options.setCurrentConfig({
            ...current,
            hotkeys: { ...current.hotkeys, show_screenshot: value },
          });
        options.toast(options.translate("toast.hotkeySet", { key: value }), "success");
      })
      .catch((error) =>
        options.toast(options.translate("toast.hotkeyFailed", { msg: String(error) }), "error"),
      );
  });
  element("set-color-hotkey-apply").addEventListener("click", () => {
    const value = colorHotkey.value.trim();
    if (!value?.includes("+")) {
      options.toast(options.translate("toast.hotkeyEmpty"));
      return;
    }
    const current = options.getConfig();
    save(
      {
        hotkeys: {
          ...(current?.hotkeys ?? {
            show_screenshot: "Alt+S",
            copy_color: "Alt+C",
            scroll_capture: "Alt+Shift+S",
          }),
          copy_color: value,
        },
      },
      true,
    );
    options.toast(options.translate("toast.colorHotkeySet", { key: value }), "success");
  });
  element("set-scroll-hotkey-apply").addEventListener("click", () => {
    const value = scrollHotkey.value.trim();
    if (!value.includes("+")) {
      options.toast(options.translate("toast.hotkeyEmpty"));
      return;
    }
    void setScrollCaptureHotkey(value)
      .then(() => {
        const current = options.getConfig();
        if (current)
          options.setCurrentConfig({
            ...current,
            hotkeys: { ...current.hotkeys, scroll_capture: value },
          });
        options.toast(options.translate("toast.hotkeySet", { key: value }), "success");
      })
      .catch((error) =>
        options.toast(options.translate("toast.hotkeyFailed", { msg: String(error) }), "error"),
      );
  });

  return {
    isOpen: () => !overlay.classList.contains("hidden"),
    closeIfOpen: () => {
      if (overlay.classList.contains("hidden")) return false;
      close();
      return true;
    },
    dismissUpdateIfOpen: () => dismissUpdate(false),
  };
}

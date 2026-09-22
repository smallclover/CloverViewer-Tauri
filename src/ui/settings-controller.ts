import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import {
  clearTempCache,
  formatSize,
  getCacheSummary,
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
  const backButton = element<HTMLButtonElement>("settings-back");
  const search = element<HTMLInputElement>("settings-search");
  const searchEmpty = element("settings-nav-empty");
  const currentTabTitle = element("settings-current-tab");
  const currentTabDesc = element("settings-current-desc");
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
  const cacheRetention = element<HTMLSelectElement>("set-cache-retention");
  const lanShareDuration = element<HTMLSelectElement>("set-lan-share-duration");
  const lanShareDownloadLimit = element<HTMLSelectElement>("set-lan-share-download-limit");
  const cacheClearAge = element<HTMLSelectElement>("set-cache-clear-age");
  const cacheSummary = element("cache-summary");
  const clearCacheButton = element<HTMLButtonElement>("clear-cache");
  const checkUpdateButton = element<HTMLButtonElement>("check-update");
  const updateOverlay = element("update-overlay");
  const updateVersion = element("update-version");
  const updateNotes = element("update-notes");
  const updateNow = element<HTMLButtonElement>("update-now");
  const updateLater = element<HTMLButtonElement>("update-later");
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"));
  const navGroups = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-nav-group]"));
  const groups = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-section]"));
  let activeTab = "general";
  let checkingForUpdate = false;
  let clearingCache = false;
  let updateResolver: ((install: boolean) => void) | undefined;

  const tabOf = (button: HTMLButtonElement) => button.dataset.settingsTab ?? "general";

  /**
   * 唯一的渲染入口：搜索词同时过滤左栏分类与右侧设置行，
   * 过滤后当前分类若不可见就自动落到第一个可见分类。
   */
  const render = (animate = false) => {
    const query = search.value.trim().toLowerCase();
    const groupHits = new Map<HTMLElement, number>();
    const tabHits = new Map<string, number>();
    for (const group of groups) {
      const tab = group.dataset.settingsSection ?? "general";
      let hits = 0;
      for (const row of group.querySelectorAll<HTMLElement>(".setting-row")) {
        const hit = !query || (row.textContent ?? "").toLowerCase().includes(query);
        row.hidden = !hit;
        if (hit) hits += 1;
      }
      groupHits.set(group, hits);
      tabHits.set(tab, (tabHits.get(tab) ?? 0) + hits);
    }

    for (const tab of tabs) {
      tab.hidden =
        Boolean(query) &&
        !(tab.textContent ?? "").toLowerCase().includes(query) &&
        (tabHits.get(tabOf(tab)) ?? 0) === 0;
    }
    for (const group of navGroups) {
      group.hidden = !Array.from(
        group.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"),
      ).some((tab) => !tab.hidden);
    }
    searchEmpty.hidden = tabs.some((tab) => !tab.hidden);

    const activeButton = tabs.find((tab) => tabOf(tab) === activeTab);
    if (!activeButton || activeButton.hidden) {
      const fallback = tabs.find((tab) => !tab.hidden);
      if (fallback) activeTab = tabOf(fallback);
    }
    for (const tab of tabs) tab.classList.toggle("active", tabOf(tab) === activeTab);

    for (const group of groups) {
      const visible =
        group.dataset.settingsSection === activeTab && (groupHits.get(group) ?? 0) > 0;
      group.hidden = !visible;
      if (visible && animate) playEnterAnimation(group, "tab-enter");
    }

    currentTabTitle.textContent = options.translate(`settings.tab.${activeTab}`);
    currentTabDesc.textContent = options.translate(`settings.tab.${activeTab}.desc`);
  };

  const selectTab = (tab: string) => {
    activeTab = tab;
    render(true);
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
  const refreshCacheSummary = async () => {
    try {
      const summary = await getCacheSummary();
      cacheSummary.textContent = options.translate("settings.cacheUsageValue", {
        files: summary.files,
        size: formatSize(summary.bytes),
      });
    } catch {
      cacheSummary.textContent = options.translate("settings.cacheUsageUnavailable");
    }
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
    cacheRetention.value = String(config.cache_cleanup_after_hours ?? 168);
    lanShareDuration.value = String(config.lan_share_duration_seconds ?? 600);
    lanShareDownloadLimit.value = String(config.lan_share_download_limit ?? 0);
    void refreshCacheSummary();
    // 每次打开都回到干净状态：无搜索词、停在「常规」。
    search.value = "";
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
    tab.addEventListener("click", () => selectTab(tabOf(tab)));
  });
  backButton.addEventListener("click", () => close());
  search.addEventListener("input", () => render());
  search.addEventListener("keydown", (event) => {
    // Esc 先清空搜索词，不要顺手把整个设置页关掉。
    if (event.key !== "Escape" || !search.value) return;
    event.stopPropagation();
    search.value = "";
    render();
  });
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  language.addEventListener("change", () => {
    const next = language.value as Lang;
    save({ language: next });
    options.setLanguage(next);
    options.applyI18n();
    // 文案换了语言，分组标题与描述都要跟着重算。
    render();
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
  cacheRetention.addEventListener("change", () =>
    save({ cache_cleanup_after_hours: Number(cacheRetention.value) }),
  );
  lanShareDuration.addEventListener("change", () =>
    save({ lan_share_duration_seconds: Number(lanShareDuration.value) }),
  );
  lanShareDownloadLimit.addEventListener("change", () =>
    save({ lan_share_download_limit: Number(lanShareDownloadLimit.value) }),
  );
  clearCacheButton.addEventListener("click", () => {
    if (clearingCache) return;
    clearingCache = true;
    clearCacheButton.disabled = true;
    void clearTempCache(Number(cacheClearAge.value))
      .then((result) => {
        options.toast(
          options.translate("toast.cacheCleared", {
            files: result.files,
            size: formatSize(result.bytes),
          }),
          "success",
        );
        void refreshCacheSummary();
      })
      .catch((error) =>
        options.toast(options.translate("toast.cacheClearFailed", { msg: String(error) }), "error"),
      )
      .finally(() => {
        clearingCache = false;
        clearCacheButton.disabled = false;
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

import {
  type AppConfig,
  checkAppUpdate,
  clearTempCache,
  formatSize,
  getCacheSummary,
  setConfig,
  setDesktopPetScale,
  setLaunchOnStartup,
  setScrollCaptureHotkey,
  setShowScreenshotHotkey,
} from "../api";
import { createConfigWriter } from "./config-writer";
import type { Lang } from "../i18n";
import { playEnterAnimation, setAnimatedVisibility, type ToastKind } from "./presentation";
import { createSelectControl } from "./select-control";
import { createUpdateController } from "./update-controller";
import { createUpdateStatusView } from "./update-status-view";

interface SettingsControllerOptions {
  getConfig: () => AppConfig | null;
  setCurrentConfig: (config: AppConfig) => void;
  setLanguage: (language: Lang) => void;
  applyTheme: (theme: AppConfig["theme"]) => void;
  applyI18n: () => void;
  refreshViewerTranslations: () => void;
  refreshImagePreviewStrip: () => void;
  refreshActiveHotkeys: () => Promise<void>;
  setDesktopPetEnabled: (enabled: boolean) => Promise<void>;
  translate: (key: string, vars?: Record<string, string | number>) => string;
  toast: (message: string, kind?: ToastKind) => void;
}

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing settings element: ${id}`);
  return found as T;
};

/** 负责设置表单的保存、快捷键注册，以及更新对话框。 */
export function createSettingsController(options: SettingsControllerOptions) {
  const overlay = element("settings-overlay");
  const button = element("btn-settings");
  const search = element<HTMLInputElement>("settings-search");
  const searchEmpty = element("settings-nav-empty");
  const currentTabTitle = element("settings-current-tab");
  const currentTabDesc = element("settings-current-desc");
  const language = element<HTMLSelectElement>("set-language");
  const theme = element<HTMLSelectElement>("set-theme");
  const uiScale = element<HTMLSelectElement>("set-ui-scale");
  const zoom = element<HTMLInputElement>("set-zoom");
  const zoomValue = element("set-zoom-val");
  const imagePreviewStrip = element<HTMLInputElement>("set-image-preview-strip");
  const screenshotHotkey = element<HTMLInputElement>("set-hotkey");
  const colorHotkey = element<HTMLInputElement>("set-color-hotkey");
  const scrollHotkey = element<HTMLInputElement>("set-scroll-hotkey");
  const magnifier = element<HTMLInputElement>("set-magnifier");
  const borderMode = element<HTMLSelectElement>("set-selection-border-mode");
  const borderColor = element<HTMLInputElement>("set-selection-border-color");
  const borderStyle = element<HTMLSelectElement>("set-selection-border-style");
  const experimentalAutoScroll = element<HTMLInputElement>("set-experimental-auto-scroll");
  const minimize = element<HTMLInputElement>("set-minimize");
  const desktopPet = element<HTMLInputElement>("set-desktop-pet");
  const desktopPetScale = element<HTMLInputElement>("set-desktop-pet-scale");
  const desktopPetScaleValue = element("set-desktop-pet-scale-value");
  const autostart = element<HTMLInputElement>("set-autostart");
  const cacheRetention = element<HTMLSelectElement>("set-cache-retention");
  const lanShareDuration = element<HTMLSelectElement>("set-lan-share-duration");
  const lanShareDownloadLimit = element<HTMLSelectElement>("set-lan-share-download-limit");
  const cacheClearAge = element<HTMLSelectElement>("set-cache-clear-age");
  const selects = [
    language,
    theme,
    borderMode,
    borderStyle,
    uiScale,
    cacheRetention,
    lanShareDuration,
    lanShareDownloadLimit,
    cacheClearAge,
  ].map(createSelectControl);
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
  let clearingCache = false;
  let updateResolver: ((install: boolean) => void) | undefined;

  const refreshBorderControls = () => {
    borderColor.disabled = borderStyle.disabled = borderMode.value !== "custom";
    for (const select of selects) select.refresh();
  };

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
    for (const select of selects) select.refresh();
  };

  const selectTab = (tab: string) => {
    activeTab = tab;
    render(true);
  };

  const writer = createConfigWriter({
    read: options.getConfig,
    render: options.setCurrentConfig,
    persist: setConfig,
  });
  // 普通设置自动保存；仅明确执行的操作在成功后显示结果。
  const save = (partial: Partial<AppConfig>) =>
    writer
      .save(partial)
      .then(() => true)
      .catch(() => {
        const current = options.getConfig();
        if (current) {
          fillValues(current);
          options.setLanguage(current.language);
          options.applyTheme(current.theme);
          options.applyI18n();
          render();
          options.refreshViewerTranslations();
          options.refreshImagePreviewStrip();
        }
        options.toast(options.translate("toast.saveFailed"), "error");
        return false;
      });

  const close = () => {
    for (const select of selects) select.close();
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
  const fillValues = (config: AppConfig) => {
    language.value = config.language;
    theme.value = config.theme;
    uiScale.value = String(config.ui_scale);
    zoom.value = String(config.zoom_sensitivity);
    zoomValue.textContent = `${config.zoom_sensitivity.toFixed(1)}×`;
    imagePreviewStrip.checked = config.image_preview_strip_enabled;
    screenshotHotkey.value = config.hotkeys.show_screenshot;
    colorHotkey.value = config.hotkeys.copy_color;
    scrollHotkey.value = config.hotkeys.scroll_capture || "Alt+Shift+S";
    magnifier.checked = config.magnifier_enabled;
    borderMode.value = config.selection_border_mode ?? "classic";
    borderColor.value = /^#[0-9a-f]{6}$/i.test(config.selection_border_color)
      ? config.selection_border_color
      : "#ffffff";
    borderStyle.value = config.selection_border_style === "solid" ? "solid" : "dashed";
    refreshBorderControls();
    experimentalAutoScroll.checked = config.experimental_auto_scroll;
    minimize.checked = config.minimize_on_close;
    desktopPet.checked = config.desktop_pet_enabled;
    desktopPetScale.value = String(config.desktop_pet_scale);
    desktopPetScaleValue.textContent = `${config.desktop_pet_scale}%`;
    autostart.checked = config.launch_on_startup;
    cacheRetention.value = String(config.cache_cleanup_after_hours ?? 168);
    lanShareDuration.value = String(config.lan_share_duration_seconds ?? 600);
    lanShareDownloadLimit.value = String(config.lan_share_download_limit ?? 0);
    for (const select of selects) select.refresh();
  };
  const open = () => {
    const config = options.getConfig();
    if (!config) return;
    fillValues(config);
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
  const updateStatus = createUpdateStatusView({
    checkButton: checkUpdateButton,
    translate: options.translate,
    onRetry: () => void updater.run(),
    onDismiss: () => updater.dismiss(),
    isBusy: () => updater.isBusy(),
  });
  const updater = createUpdateController({
    check: checkAppUpdate,
    confirm: (update) => showUpdate(update.version, update.body?.trim()),
    onState: updateStatus.render,
    yieldUi: () =>
      new Promise((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0))),
    wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
  });
  const checkForUpdate = updater.run;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tabOf(tab)));
  });
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
    updateStatus.render();
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
  uiScale.addEventListener("change", () =>
    save({ ui_scale: Number(uiScale.value) as AppConfig["ui_scale"] }),
  );
  zoom.addEventListener("input", () => {
    zoomValue.textContent = `${Number(zoom.value).toFixed(1)}×`;
  });
  zoom.addEventListener("change", () => save({ zoom_sensitivity: Number(zoom.value) }));
  const setImagePreviewStripEnabled = (enabled: boolean) => {
    imagePreviewStrip.checked = enabled;
    void save({ image_preview_strip_enabled: enabled });
    options.refreshImagePreviewStrip();
  };
  imagePreviewStrip.addEventListener("change", () =>
    setImagePreviewStripEnabled(imagePreviewStrip.checked),
  );
  magnifier.addEventListener("change", () => save({ magnifier_enabled: magnifier.checked }));
  borderMode.addEventListener("change", () => {
    save({ selection_border_mode: borderMode.value as AppConfig["selection_border_mode"] });
    refreshBorderControls();
  });
  borderColor.addEventListener("change", () => save({ selection_border_color: borderColor.value }));
  borderStyle.addEventListener("change", () =>
    save({ selection_border_style: borderStyle.value as AppConfig["selection_border_style"] }),
  );
  experimentalAutoScroll.addEventListener("change", () =>
    save({ experimental_auto_scroll: experimentalAutoScroll.checked }),
  );
  minimize.addEventListener("change", () => save({ minimize_on_close: minimize.checked }));
  desktopPet.addEventListener("change", () => {
    const enabled = desktopPet.checked;
    void options.setDesktopPetEnabled(enabled).catch((error) => {
      desktopPet.checked = options.getConfig()?.desktop_pet_enabled ?? !enabled;
      options.toast(options.translate("toast.desktopPetFailed", { msg: String(error) }), "error");
    });
  });
  desktopPetScale.addEventListener("input", () => {
    desktopPetScaleValue.textContent = `${desktopPetScale.value}%`;
  });
  desktopPetScale.addEventListener("change", () => {
    const scale = Number(desktopPetScale.value);
    void setDesktopPetScale(scale)
      .then(() => {
        const current = options.getConfig();
        if (current) options.setCurrentConfig({ ...current, desktop_pet_scale: scale });
      })
      .catch((error) => {
        const current = options.getConfig();
        if (current) {
          desktopPetScale.value = String(current.desktop_pet_scale);
          desktopPetScaleValue.textContent = `${current.desktop_pet_scale}%`;
        }
        options.toast(options.translate("toast.saveFailed", { msg: String(error) }), "error");
      });
  });
  autostart.addEventListener("change", () => {
    const enabled = autostart.checked;
    autostart.disabled = true;
    void setLaunchOnStartup(enabled)
      .then((saved) => {
        options.setCurrentConfig(saved);
      })
      .catch((error) => {
        autostart.checked = options.getConfig()?.launch_on_startup ?? !enabled;
        options.toast(options.translate("toast.autostartFailed", { msg: String(error) }), "error");
      })
      .finally(() => {
        autostart.disabled = false;
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
        void options.refreshActiveHotkeys();
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
    void save({
      hotkeys: {
        ...(current?.hotkeys ?? {
          show_screenshot: "Alt+S",
          copy_color: "Alt+C",
          scroll_capture: "Alt+Shift+S",
        }),
        copy_color: value,
      },
    }).then((saved) => {
      if (saved)
        options.toast(options.translate("toast.colorHotkeySet", { key: value }), "success");
    });
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
        void options.refreshActiveHotkeys();
        options.toast(options.translate("toast.hotkeySet", { key: value }), "success");
      })
      .catch((error) =>
        options.toast(options.translate("toast.hotkeyFailed", { msg: String(error) }), "error"),
      );
  });

  return {
    open,
    selectTab,
    checkForUpdate,
    close,
    setImagePreviewStripEnabled,
    isOpen: () => !overlay.classList.contains("hidden"),
    closeIfOpen: () => {
      if (overlay.classList.contains("hidden")) return false;
      close();
      return true;
    },
    dismissUpdateIfOpen: () => dismissUpdate(false),
  };
}

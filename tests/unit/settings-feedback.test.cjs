const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(api = {}, options = {}) {
  const elements = new Map(), notices = [], writes = [], scales = [], translations = [];
  let config = {
    language: "Zh", theme: "dark", ui_scale: 100, zoom_sensitivity: 1,
    image_preview_strip_enabled: true, magnifier_enabled: true,
    desktop_pet_scale: 100, launch_on_startup: false,
    hotkeys: { show_screenshot: "Alt+S", copy_color: "Alt+C", scroll_capture: "Alt+Shift+S" },
  };
  const element = id => {
    if (!elements.has(id)) {
      const handlers = new Map();
      elements.set(id, {
        value: "", dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {}, addEventListener: (name, handler) => handlers.set(name, handler),
        fire: name => handlers.get(name)?.({}),
      });
    }
    return elements.get(id);
  };
  const { createSettingsController } = loadTs("ui/settings-controller.ts", {
    "../api": {
      setConfig: async next => { writes.push(next); return next; },
      setDesktopPetScale: async scale => { scales.push(scale); },
      setLaunchOnStartup: async enabled => ({ ...config, launch_on_startup: enabled }),
      setShowScreenshotHotkey: async () => {}, setScrollCaptureHotkey: async () => {},
      getCacheSummary: async () => ({ files: 0, bytes: 0 }), formatSize: () => "0",
      clearTempCache: async () => ({ files: 1, bytes: 12, failed_files: 0, first_error: null }), ...api,
    },
    "./select-control": { createSelectControl: () => ({ refresh() {}, close() {} }) },
    "./update-controller": { createUpdateController: () => ({ run() {}, isBusy: () => false, dismiss() {} }) },
    "./update-status-view": { createUpdateStatusView: () => ({ render() {} }) },
    "./presentation": { playEnterAnimation() {}, setAnimatedVisibility() {} },
  }, { document: { getElementById: element, querySelectorAll: () => [] } });
  const controller = createSettingsController({
    getConfig: () => config, setCurrentConfig: next => { config = next; },
    setLanguage() {}, applyTheme() {}, applyI18n() {}, refreshViewerTranslations() {},
    refreshImagePreviewStrip() {}, refreshActiveHotkeys: async () => {}, setDesktopPetEnabled: async () => {},
    translate: (key, vars) => { translations.push({ key, vars }); return key; },
    toast: (message, kind) => notices.push({ message, kind }), ...options,
  });
  controller.open();
  return { element, notices, writes, scales, translations, config: () => config };
}

test("ordinary settings save quietly and sliders persist only the released value", async () => {
  const f = fixture();
  f.element("set-theme").value = "light";
  f.element("set-theme").fire("change");
  await flush();
  assert.equal(f.config().theme, "light");
  const before = f.writes.length;
  for (const value of ["1.2", "1.6", "2.0"]) {
    f.element("set-zoom").value = value;
    f.element("set-zoom").fire("input");
  }
  assert.equal(f.element("set-zoom-val").textContent, "2.0×");
  assert.equal(f.writes.length, before);
  f.element("set-zoom").fire("change");
  await flush();
  assert.equal(f.writes.length, before + 1);
  assert.equal(f.config().zoom_sensitivity, 2);
  for (const value of ["110", "125", "150"]) {
    f.element("set-desktop-pet-scale").value = value;
    f.element("set-desktop-pet-scale").fire("input");
  }
  assert.equal(f.element("set-desktop-pet-scale-value").textContent, "150%");
  assert.deepEqual(f.scales, []);
  f.element("set-desktop-pet-scale").fire("change");
  await flush();
  assert.deepEqual(f.scales, [150]);
  assert.equal(f.config().desktop_pet_scale, 150);
  f.element("set-autostart").checked = true;
  f.element("set-autostart").fire("change");
  await flush();
  assert.equal(f.config().launch_on_startup, true);
  assert.equal(f.element("set-autostart").disabled, false);
  assert.deepEqual(f.notices, []);
});

test("explicit hotkey apply and cache cleanup keep their result feedback", async () => {
  const f = fixture();
  f.element("set-hotkey-apply").fire("click");
  f.element("set-scroll-hotkey-apply").fire("click");
  f.element("set-color-hotkey-apply").fire("click");
  await flush();
  f.element("clear-cache").fire("click");
  await flush();
  assert.deepEqual(f.notices.map(notice => notice.message), [
    "toast.hotkeySet", "toast.hotkeySet", "toast.colorHotkeySet", "toast.cacheCleared",
  ]);
  assert.ok(f.notices.every(notice => notice.kind === "success"));
});

test("cache cleanup reports partial and complete file failures as errors with the actual reason", async () => {
  for (const [files, key] of [[2, "toast.cacheClearPartial"], [0, "toast.cacheClearIncomplete"]]) {
    let summaries = 0;
    const f = fixture({
      getCacheSummary: async () => { summaries++; return { files: 1, bytes: 10 }; },
      formatSize: bytes => `${bytes} B`,
      clearTempCache: async () => ({ files, bytes: files * 10, failed_files: 1, first_error: "locked.png: sharing violation" }),
    });
    f.element("clear-cache").fire("click");
    await flush();
    assert.deepEqual(f.notices, [{ message: key, kind: "error" }]);
    const feedback = f.translations.find(item => item.key === key).vars;
    assert.equal(feedback.files, files);
    assert.equal(feedback.failed, 1);
    assert.equal(feedback.size, `${files * 10} B`);
    assert.match(feedback.msg, /sharing violation/);
    assert.equal(summaries, 2);
    assert.equal(f.element("clear-cache").disabled, false);
  }
});

test("cache directory failures show failure and unavailable usage instead of success or zero usage", async () => {
  const f = fixture({
    clearTempCache: async () => { throw Error("access denied"); },
    getCacheSummary: async () => { throw Error("access denied"); },
  });
  f.element("clear-cache").fire("click");
  await flush();
  assert.deepEqual(f.notices, [{ message: "toast.cacheClearFailed", kind: "error" }]);
  assert.match(f.translations.find(item => item.key === "toast.cacheClearFailed").vars.msg, /access denied/);
  assert.equal(f.element("cache-summary").textContent, "settings.cacheUsageUnavailable");
  assert.equal(f.element("clear-cache").disabled, false);
});

test("empty cleanup is informational, duplicate clicks are ignored and stale usage cannot overwrite the new count", async () => {
  let complete, oldSummary, calls = 0, summaries = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  const f = fixture({
    clearTempCache: () => { calls++; return pending; },
    getCacheSummary: () => ++summaries === 1
      ? new Promise(resolve => { oldSummary = resolve; })
      : Promise.resolve({ files: 0, bytes: 0 }),
  });
  f.element("clear-cache").fire("click");
  f.element("clear-cache").fire("click");
  assert.equal(calls, 1);
  assert.equal(f.element("clear-cache").disabled, true);
  complete({ files: 0, bytes: 0, failed_files: 0, first_error: null });
  await flush();
  assert.deepEqual(f.notices, [{ message: "toast.cacheNothingToClear", kind: "info" }]);
  oldSummary({ files: 20, bytes: 200 });
  await flush();
  const counts = f.translations.filter(item => item.key === "settings.cacheUsageValue");
  assert.equal(counts.length, 1);
  assert.equal(counts[0].vars.files, 0);
  assert.equal(f.element("clear-cache").disabled, false);
});

test("window decoration choices save quietly and size persists only on release", async () => {
  const f = fixture();
  assert.equal(f.element("set-window-decoration").value, "off");
  assert.equal(f.element("set-window-decoration-scale").disabled, true);
  for (const style of ["lean", "peek", "off"]) {
    f.element("set-window-decoration").value = style;
    f.element("set-window-decoration").fire("change");
    await flush();
    assert.equal(f.config().window_decoration, style);
    assert.equal(f.element("set-window-decoration-scale").disabled, style === "off");
  }
  const before = f.writes.length;
  f.element("set-window-decoration-scale").value = "125";
  f.element("set-window-decoration-scale").fire("input");
  assert.equal(f.element("set-window-decoration-scale-value").textContent, "125%");
  assert.equal(f.writes.length, before);
  f.element("set-window-decoration-scale").fire("change");
  await flush();
  assert.equal(f.config().window_decoration_scale, 125);
  assert.deepEqual(f.notices, []);
});

test("failed decoration persistence restores style, size and disabled controls", async () => {
  const f = fixture({ setConfig: async () => { throw Error("disk full"); } });
  f.element("set-window-decoration").value = "lean";
  f.element("set-window-decoration").fire("change");
  await flush();
  assert.equal(f.element("set-window-decoration").value, "off");
  assert.equal(f.element("set-window-decoration-scale").disabled, true);
  f.element("set-window-decoration-scale").value = "140";
  f.element("set-window-decoration-scale").fire("change");
  await flush();
  assert.equal(f.element("set-window-decoration-scale").value, "100");
  assert.ok(f.notices.every(notice => notice.message === "toast.saveFailed" && notice.kind === "error"));
});

test("desktop pet size follows the switch and rolls back when enabling fails", async () => {
  const f = fixture();
  const enabled = f.element("set-desktop-pet"), scale = f.element("set-desktop-pet-scale");
  assert.equal(scale.disabled, true);
  enabled.checked = true; enabled.fire("change");
  assert.equal(scale.disabled, false);
  await flush();
  enabled.checked = false; enabled.fire("change");
  assert.equal(scale.disabled, true);
  const failed = fixture({}, { setDesktopPetEnabled: async () => { throw Error("load failed"); } });
  failed.element("set-desktop-pet").checked = true;
  failed.element("set-desktop-pet").fire("change");
  assert.equal(failed.element("set-desktop-pet-scale").disabled, false);
  await flush();
  assert.equal(failed.element("set-desktop-pet").checked, false);
  assert.equal(failed.element("set-desktop-pet-scale").disabled, true);
  assert.equal(failed.notices.at(-1).kind, "error");
});

test("color hotkey apply waits for persistence and reports failure without a success toast", async () => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const f = fixture({ setConfig: () => pending });
  f.element("set-color-hotkey").value = "Alt+V";
  f.element("set-color-hotkey-apply").fire("click");
  assert.deepEqual(f.notices, []);
  reject(Error("disk full"));
  await flush();
  assert.equal(f.config().hotkeys.copy_color, "Alt+C");
  assert.equal(f.element("set-color-hotkey").value, "Alt+C");
  assert.deepEqual(f.notices, [{ message: "toast.saveFailed", kind: "error" }]);
});

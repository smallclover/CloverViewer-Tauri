const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(api = {}) {
  const elements = new Map(), notices = [], writes = [], scales = [];
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
      clearTempCache: async () => ({ files: 1, bytes: 12 }), ...api,
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
    translate: key => key, toast: (message, kind) => notices.push({ message, kind }),
  });
  controller.open();
  return { element, notices, writes, scales, config: () => config };
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

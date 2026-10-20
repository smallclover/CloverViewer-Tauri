const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
  const elements = new Map(), calls = [], notices = [];
  let config = { ocr_engine: "system", ocr_language: "auto" };
  let model = { supported: true, installed: false, busy: false, downloaded_bytes: 0, download_bytes: 100, installed_bytes: 0 };
  const element = id => {
    if (!elements.has(id)) {
      const handlers = new Map();
      elements.set(id, { value: "", hidden: false, disabled: false, dataset: {},
        addEventListener: (name, fn) => handlers.set(name, fn),
        fire: name => handlers.get(name)?.({}),
      });
    }
    return elements.get(id);
  };
  const api = {
    formatSize: n => String(n),
    getOcrModelStatus: async () => ({ ...model }),
    downloadOcrModel: async () => { calls.push("download"); model = { ...model, installed: true, installed_bytes: 90 }; return model; },
    cancelOcrModelDownload: async () => { calls.push("cancel"); },
    removeOcrModel: async () => { calls.push("remove"); model = { ...model, installed: false, installed_bytes: 0 }; return model; },
    ...overrides.api,
  };
  const { createOcrSettingsController } = loadTs("ui/ocr-settings-controller.ts", {
    "../api": api,
    "./select-control": { createSelectControl: () => ({ refresh() {}, close() {} }) },
  }, { document: { getElementById: element }, setTimeout: () => 1, clearTimeout() {} });
  const controller = createOcrSettingsController({
    getConfig: () => config,
    save: async patch => { calls.push(`save:${patch.ocr_engine ?? patch.ocr_language}`); if (overrides.saveFails) return false; config = { ...config, ...patch }; return true; },
    translate: key => key,
    toast: (message, kind) => notices.push({ message, kind }),
  });
  controller.fillValues(config);
  return { element, controller, calls, notices, config: () => config, setModel: patch => { model = { ...model, ...patch }; } };
}

test("high-accuracy engine is unavailable until installed and downloading does not switch engines", async () => {
  const f = fixture();
  await f.controller.refresh();
  assert.equal(f.element("ocr-paddle-option").disabled, true);
  f.element("set-ocr-engine").value = "paddle";
  await f.element("set-ocr-engine").fire("change");
  assert.equal(f.config().ocr_engine, "system");
  await f.element("ocr-model-download").fire("click");
  assert.equal(f.config().ocr_engine, "system");
  assert.equal(f.element("ocr-paddle-option").disabled, false);
  assert.equal(f.element("ocr-model-download").textContent, "ocr.model.complete");
  assert.equal(f.element("ocr-model-download").disabled, true);
  assert.equal(f.element("ocr-model-download").dataset.i18n, "ocr.model.complete");
  assert.equal(f.element("ocr-model-status").textContent, "ocr.model.ready");
  assert.equal(f.element("ocr-model-status").dataset.state, "ready");
  f.element("set-ocr-engine").value = "paddle";
  await f.element("set-ocr-engine").fire("change");
  assert.equal(f.config().ocr_engine, "paddle");
  assert.equal(f.element("set-ocr-language").disabled, true);
  assert.equal(f.element("ocr-model-status").textContent, "ocr.model.active");
});

test("deletion waits for the system preference to persist", async () => {
  const f = fixture();
  f.setModel({ installed: true, installed_bytes: 90 });
  await f.controller.refresh();
  assert.equal(f.element("ocr-model-download").textContent, "ocr.model.complete");
  f.element("set-ocr-engine").value = "paddle";
  await f.element("set-ocr-engine").fire("change");
  f.calls.length = 0;
  await f.element("ocr-model-remove").fire("click");
  assert.deepEqual(f.calls, ["save:system", "remove"]);
  assert.equal(f.element("set-ocr-engine").value, "system");
  assert.equal(f.element("ocr-paddle-option").disabled, true);
  assert.equal(f.element("ocr-model-download").textContent, "ocr.model.download");
  assert.equal(f.element("ocr-model-status").dataset.state, "idle");
});

test("a failed preference write keeps downloaded components", async () => {
  const f = fixture({ saveFails: true });
  f.setModel({ installed: true, installed_bytes: 90 });
  await f.controller.refresh();
  await f.element("ocr-model-remove").fire("click");
  assert.deepEqual(f.calls, ["save:system"]);
  assert.equal(f.element("ocr-paddle-option").disabled, false);
});

test("a cancelled or failed download never enables the engine", async () => {
  for (const error of ["OCR_DOWNLOAD_CANCELLED", "checksum mismatch"]) {
    const f = fixture({ api: { downloadOcrModel: async () => { throw new Error(error); } } });
    await f.controller.refresh();
    await f.element("ocr-model-download").fire("click");
    assert.equal(f.config().ocr_engine, "system");
    assert.equal(f.element("ocr-paddle-option").disabled, true);
    assert.equal(f.element("ocr-model-download").disabled, false);
    assert.equal(f.notices.length, error === "OCR_DOWNLOAD_CANCELLED" ? 0 : 1);
  }
});

test("download can be cancelled and unavailable status keeps engine selection disabled", async () => {
  const f = fixture({ api: { getOcrModelStatus: async () => { throw new Error("offline"); } } });
  await f.controller.refresh();
  assert.equal(f.element("set-ocr-engine").disabled, true);
  assert.equal(f.element("ocr-model-status").textContent, "ocr.model.unavailable");
  f.element("ocr-model-cancel").fire("click");
  await flush();
  assert.deepEqual(f.calls, ["cancel"]);
});

test("recognition language is saved separately from the interface language", async () => {
  const f = fixture();
  f.element("set-ocr-language").value = "ja";
  f.element("set-ocr-language").fire("change");
  await flush();
  assert.equal(f.config().ocr_language, "ja");
  assert.deepEqual(f.calls, ["save:ja"]);
});

test("OCR errors explain missing language packs and model recovery in the chosen UI language", () => {
  const { ocrErrorMessage } = loadTs("ui/ocr-error.ts");
  assert.equal(ocrErrorMessage("OCR_LANGUAGE_UNAVAILABLE", key => key), "ocr.error.language");
  assert.equal(ocrErrorMessage("OCR_MODEL_CORRUPT", key => key), "ocr.error.corrupt");
  assert.equal(ocrErrorMessage("unexpected", key => key), "unexpected");
});

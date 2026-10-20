import {
  type AppConfig,
  type OcrModelStatus,
  cancelOcrModelDownload,
  downloadOcrModel,
  formatSize,
  getOcrModelStatus,
  removeOcrModel,
} from "../api";
import { createSelectControl } from "./select-control";

interface OcrSettingsOptions {
  getConfig: () => AppConfig | null;
  save: (patch: Partial<AppConfig>) => Promise<boolean>;
  translate: (key: string, vars?: Record<string, string | number>) => string;
  toast: (message: string, kind: "error" | "success") => void;
}

/** Downloads never change the chosen engine. Persist the system engine before removing assets. */
export function createOcrSettingsController(options: OcrSettingsOptions) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const engine = element<HTMLSelectElement>("set-ocr-engine");
  const language = element<HTMLSelectElement>("set-ocr-language");
  const paddle = element<HTMLOptionElement>("ocr-paddle-option");
  const status = element<HTMLElement>("ocr-model-status");
  const progress = element<HTMLProgressElement>("ocr-model-progress");
  const download = element<HTMLButtonElement>("ocr-model-download");
  const cancel = element<HTMLButtonElement>("ocr-model-cancel");
  const remove = element<HTMLButtonElement>("ocr-model-remove");
  const selects = [engine, language].map(createSelectControl);
  let model: OcrModelStatus | null = null;
  let operation: "download" | "remove" | "save" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;
  let failed = false;

  const render = () => {
    const busy = operation !== null || model?.busy === true;
    const ready =
      !!model?.installed &&
      !model.busy &&
      !failed &&
      operation !== "download" &&
      operation !== "remove";
    const active = ready && operation !== "save" && options.getConfig()?.ocr_engine === "paddle";
    const downloadLabel = ready ? "ocr.model.complete" : "ocr.model.download";
    download.textContent = options.translate(downloadLabel);
    download.dataset.i18n = downloadLabel;
    download.dataset.state = ready ? "ready" : "idle";
    status.dataset.state = ready ? "ready" : "idle";
    paddle.disabled = !model?.installed || !model.supported;
    engine.disabled = busy || !model;
    language.disabled = busy || engine.value === "paddle";
    download.disabled = busy || !model?.supported || model.installed;
    remove.disabled = busy || !model || model.installed_bytes === 0;
    cancel.hidden = operation !== "download" && !model?.busy;
    cancel.disabled = operation === "remove";
    progress.hidden = cancel.hidden;
    progress.max = model?.download_bytes || 1;
    progress.value = model?.downloaded_bytes || 0;
    const key = failed
      ? "ocr.model.unavailable"
      : operation === "remove"
        ? "ocr.model.removing"
        : !cancel.hidden
          ? "ocr.model.downloading"
          : model && !model.supported
            ? "ocr.model.unsupported"
            : model?.installed
              ? active
                ? "ocr.model.active"
                : "ocr.model.ready"
              : "ocr.model.absent";
    status.textContent = options.translate(key, {
      size: formatSize(model?.installed_bytes || 0),
      received: formatSize(model?.downloaded_bytes || 0),
      total: formatSize(model?.download_bytes || 0),
    });
    for (const select of selects) select.refresh();
  };
  const fillValues = (config: AppConfig) => {
    engine.value = config.ocr_engine ?? "system";
    language.value = config.ocr_language ?? "auto";
    render();
  };
  const refresh = async () => {
    const current = ++request;
    clearTimeout(timer);
    try {
      const result = await getOcrModelStatus();
      if (current !== request) return;
      model = result;
      failed = false;
    } catch {
      if (current !== request) return;
      failed = true;
    }
    render();
    if (model?.busy || operation === "download") timer = setTimeout(() => void refresh(), 800);
  };
  engine.addEventListener("change", async () => {
    const next = engine.value as AppConfig["ocr_engine"];
    if (operation || (next === "paddle" && !model?.installed)) {
      const config = options.getConfig();
      if (config) fillValues(config);
      return;
    }
    operation = "save";
    render();
    await options.save({ ocr_engine: next });
    operation = null;
    const config = options.getConfig();
    if (config) fillValues(config);
  });
  language.addEventListener(
    "change",
    () =>
      void options.save({
        ocr_language: language.value as AppConfig["ocr_language"],
      }),
  );
  download.addEventListener("click", async () => {
    if (operation || model?.busy || !model?.supported || model.installed) return;
    operation = "download";
    if (model) model = { ...model, downloaded_bytes: 0 };
    render();
    void refresh();
    try {
      model = await downloadOcrModel();
      options.toast(options.translate("ocr.model.downloaded"), "success");
    } catch (error) {
      if (!String(error).includes("OCR_DOWNLOAD_CANCELLED")) {
        options.toast(options.translate("ocr.model.downloadFailed"), "error");
      }
    } finally {
      operation = null;
      render();
      await refresh();
    }
  });
  cancel.addEventListener("click", () => {
    void cancelOcrModelDownload().catch(() =>
      options.toast(options.translate("ocr.model.cancelFailed"), "error"),
    );
  });
  remove.addEventListener("click", async () => {
    if (operation || model?.busy) return;
    operation = "remove";
    render();
    try {
      if (!(await options.save({ ocr_engine: "system" }))) return;
      model = await removeOcrModel();
      options.toast(options.translate("ocr.model.removed"), "success");
    } catch {
      options.toast(options.translate("ocr.model.removeFailed"), "error");
    } finally {
      operation = null;
      const config = options.getConfig();
      if (config) fillValues(config);
      await refresh();
    }
  });
  return {
    fillValues,
    refresh,
    render,
    close: () => {
      for (const select of selects) select.close();
    },
  };
}

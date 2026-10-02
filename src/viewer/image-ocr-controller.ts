import type { ImageEntry } from "../api";

interface ImageOcrControllerOptions {
  panel: HTMLElement;
  copyText: (text: string) => Promise<void>;
  translate: (key: string, params?: Record<string, string | number>) => string;
  toast: (message: string, kind?: "success" | "error" | "info") => void;
  onClose: () => void;
}

/** 识别结果按路径缓存，仅保存在本次查看器会话内。 */
export function createImageOcrController(options: ImageOcrControllerOptions) {
  const results = new Map<string, string>();
  const keyFor = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  let activePath: string | undefined;

  const header = document.createElement("header");
  header.className = "image-ocr-header";
  const title = document.createElement("h3");
  const close = document.createElement("button");
  close.className = "image-ocr-close";
  close.type = "button";
  close.textContent = "×";
  close.addEventListener("click", options.onClose);
  header.append(title, close);

  const hint = document.createElement("p");
  hint.className = "image-ocr-hint";
  const body = document.createElement("textarea");
  body.className = "image-ocr-text";
  body.spellcheck = false;
  body.addEventListener("input", () => {
    if (activePath) results.set(activePath, body.value);
    copy.disabled = body.value.length === 0;
  });
  body.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      options.onClose();
    }
  });

  const copy = document.createElement("button");
  copy.className = "image-ocr-copy";
  copy.type = "button";
  copy.addEventListener("click", () => {
    if (!body.value) return;
    void options.copyText(body.value).then(
      () => options.toast(options.translate("shot.copied"), "success"),
      (error) =>
        options.toast(options.translate("toast.copyFailed", { msg: String(error) }), "error"),
    );
  });
  options.panel.append(header, hint, body, copy);

  const refreshTranslations = () => {
    title.textContent = options.translate("shot.ocrTitle");
    close.title = options.translate("shot.close");
    close.setAttribute("aria-label", close.title);
    hint.textContent = options.translate("prop.ocrHint");
    body.setAttribute("aria-label", options.translate("shot.ocrTitle"));
    copy.textContent = options.translate("shot.copyAll");
  };
  refreshTranslations();

  return {
    setResult(path: string, text: string) {
      results.set(keyFor(path), text);
    },
    hasResult(path: string) {
      return results.has(keyFor(path));
    },
    open(entry: ImageEntry) {
      const key = keyFor(entry.path);
      const text = results.get(key);
      if (text === undefined) return false;
      activePath = key;
      body.value = text;
      copy.disabled = text.length === 0;
      options.panel.classList.remove("collapsed");
      return true;
    },
    close() {
      options.panel.classList.add("collapsed");
      activePath = undefined;
    },
    isOpen: () => !options.panel.classList.contains("collapsed"),
    refreshTranslations,
  };
}

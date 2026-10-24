import type { ImageEntry, OcrDocument } from "../api";
import {
  copyContent,
  createOcrSession,
  keysFor,
  selectedState,
  unitsFor,
  type OcrCopyFormat,
  type OcrSession,
  type OcrUnit,
} from "../ocr/selection";
import { uiIcon } from "../ui/icons";
import { createOcrImageOverlay } from "./ocr/image-overlay";
import { createOcrResultList } from "./ocr/result-list";
import { createOcrPanelResize } from "./ocr/panel-resize";

interface ImageOcrControllerOptions {
  panel: HTMLElement;
  stage: HTMLElement;
  getImage: () => HTMLImageElement;
  getEntry: (path: string) => ImageEntry | undefined;
  isActive: () => boolean;
  onLayout: () => void;
  panImage: (x: number, y: number) => void;
  copyText: (text: string) => Promise<void>;
  translate: (key: string, params?: Record<string, string | number>) => string;
  toast: (message: string, kind?: "success" | "error" | "info") => void;
  onClose: () => void;
}

/** One canonical text/selection session feeds all views and clipboard operations. */
export function createImageOcrController(options: ImageOcrControllerOptions) {
  const results = new Map<string, { session: OcrSession; identity?: string }>();
  const keyFor = (path: string) => path.split(String.fromCharCode(92)).join("/").toLowerCase();
  const identity = (entry: ImageEntry) => `${entry.size}:${entry.modified}`;
  const t = options.translate;
  let active: OcrSession | undefined;
  let fullView = false;
  let byLine = false;
  let browsing = false;
  let format: OcrCopyFormat = "paragraphs";
  const translations: Array<() => void> = [];
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "") => {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  };
  const label = (element: HTMLElement, key: string) =>
    translations.push(() => {
      element.textContent = t(key);
    });
  const button = (key: string, action: () => void, className = "") => {
    const element = node("button", className);
    element.type = "button";
    label(element, key);
    element.addEventListener("click", action);
    return element;
  };
  const header = node("header", "image-ocr-header");
  const title = node("h3");
  label(title, "shot.ocrTitle");
  const close = node("button", "image-ocr-close");
  close.type = "button";
  close.innerHTML = uiIcon("close");
  close.addEventListener("click", options.onClose);
  translations.push(() => {
    close.title = t("shot.close");
    close.setAttribute("aria-label", close.title);
  });
  header.append(title, close);
  const tabs = node("div", "ocr-view-tabs");
  tabs.setAttribute("role", "tablist");
  const blocksTab = button("ocr.result.blocks", () => setView(false));
  const fullTab = button("ocr.result.full", () => setView(true));
  for (const tab of [blocksTab, fullTab]) {
    tab.setAttribute("role", "tab");
    tab.tabIndex = 0;
  }
  blocksTab.id = "ocr-blocks-tab";
  fullTab.id = "ocr-full-tab";
  blocksTab.setAttribute("aria-controls", "ocr-result-content");
  fullTab.setAttribute("aria-controls", "ocr-result-content");
  tabs.append(blocksTab, fullTab);
  tabs.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setView(event.key === "Home" ? false : event.key === "End" ? true : !fullView);
    (fullView ? fullTab : blocksTab).focus();
  });
  const tools = node("div", "ocr-result-tools");
  const grouping = node("select");
  for (const [value, key] of [
    ["paragraphs", "ocr.result.paragraphs"],
    ["lines", "ocr.result.lines"],
  ]) {
    const option = node("option");
    option.value = value;
    label(option, key);
    grouping.append(option);
  }
  translations.push(() => grouping.setAttribute("aria-label", t("ocr.result.grouping")));
  grouping.addEventListener("change", () => {
    byLine = grouping.value === "lines";
    list.show(active, byLine);
    overlay.setMode(byLine, browsing);
    changed();
  });
  const selectAll = button("ocr.result.selectAll", () => {
    if (active)
      for (const block of active.blocks) for (const key of keysFor(block)) active.selected.add(key);
    changed();
  });
  const clear = button("ocr.result.clear", () => {
    active?.selected.clear();
    changed();
  });
  tools.append(grouping, selectAll, clear);
  const mode = button(
    "ocr.result.selectImage",
    () => {
      browsing = !browsing;
      overlay.setMode(byLine, browsing);
      changed();
    },
    "ocr-image-mode",
  );
  const hint = node("p", "ocr-result-hint");
  const content = node("div", "ocr-result-content");
  content.id = "ocr-result-content";
  content.setAttribute("role", "tabpanel");
  const rows = node("div", "ocr-result-list");
  const full = node("pre", "ocr-full-text");
  full.tabIndex = 0;
  content.append(rows, full);
  const footer = node("footer", "ocr-result-footer");
  const summary = node("div", "ocr-copy-summary");
  const count = node("span");
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  const copyFormat = node("select");
  for (const [value, key] of [
    ["paragraphs", "ocr.result.normalize"],
    ["lines", "ocr.result.keepLines"],
  ]) {
    const option = node("option");
    option.value = value;
    label(option, key);
    copyFormat.append(option);
  }
  translations.push(() => copyFormat.setAttribute("aria-label", t("ocr.result.copyFormat")));
  copyFormat.addEventListener("change", () => {
    format = copyFormat.value as OcrCopyFormat;
    changed();
  });
  summary.append(count, copyFormat);
  const status = node("span", "ocr-copy-status");
  status.setAttribute("role", "status");
  let statusTimer = 0;
  const copy = async (all = false) => {
    if (!active) return;
    const session = active,
      text = copyContent(session, format, all);
    if (!text) return;
    try {
      await options.copyText(text);
      if (active !== session) return;
      status.textContent = t("shot.copied");
      window.clearTimeout(statusTimer);
      statusTimer = window.setTimeout(() => {
        status.textContent = "";
      }, 1600);
    } catch (error) {
      options.toast(t("toast.copyFailed", { msg: String(error) }), "error");
    }
  };
  const copySelected = button(
    "ocr.result.copySelected",
    () => {
      void copy();
    },
    "image-ocr-copy",
  );
  const copyAll = button(
    "shot.copyAll",
    () => {
      void copy(true);
    },
    "ocr-copy-all",
  );
  footer.append(summary, copySelected, copyAll, status);
  options.panel.append(header, tabs, tools, mode, hint, content, footer);
  const hover = (unit: OcrUnit | null) => {
    list.hover(unit);
    overlay.hover(unit);
  };
  const list = createOcrResultList({
    root: rows,
    translate: t,
    changed: () => changed(),
    hover,
    locate: (unit) => {
      hover(unit);
      overlay.reveal(unit);
    },
  });
  const overlay = createOcrImageOverlay({
    stage: options.stage,
    getImage: options.getImage,
    panImage: options.panImage,
    changed: () => changed(),
    hover,
    locate: (unit) => {
      setView(false);
      list.locate(unit);
      hover(unit);
    },
  });
  const resize = createOcrPanelResize(options.panel, options.onLayout);
  const container = options.panel.parentElement;
  if (container)
    new ResizeObserver(() => {
      container.classList.toggle("ocr-stacked", !!active && container.clientWidth < 900);
    }).observe(container);
  function changed() {
    const units = active ? unitsFor(active, byLine) : [];
    const selected = active
      ? units.filter((unit) => selectedState(active as OcrSession, unit) !== "none").length
      : 0;
    count.textContent = t("ocr.result.selected", { n: selected, total: units.length });
    copySelected.disabled = !active || !copyContent(active, format);
    copyAll.disabled = !active || !copyContent(active, format, true);
    full.textContent = active ? copyContent(active, format, true) : "";
    blocksTab.tabIndex = fullView ? -1 : 0;
    fullTab.tabIndex = fullView ? 0 : -1;
    content.setAttribute("aria-labelledby", fullView ? fullTab.id : blocksTab.id);
    full.hidden = !fullView;
    rows.hidden = fullView;
    tools.hidden = fullView;
    blocksTab.setAttribute("aria-selected", String(!fullView));
    fullTab.setAttribute("aria-selected", String(fullView));
    const coordinates = !!active?.document?.lines.length;
    mode.hidden = !coordinates;
    mode.textContent = t(browsing ? "ocr.result.browseImage" : "ocr.result.selectImage");
    mode.setAttribute("aria-pressed", String(!browsing));
    hint.textContent = t(coordinates ? "ocr.result.hint" : "ocr.result.legacyHint");
    list.update();
    overlay.update();
  }
  function setView(fullText: boolean) {
    list.cancelEdit();
    fullView = fullText;
    changed();
  }
  const handleKey = (event: KeyboardEvent) => {
    if (!active || !options.isActive() || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (overlay.cancel() || resize.cancel() || list.cancelEdit()) return;
      if (active.selected.size) {
        active.selected.clear();
        changed();
      } else options.onClose();
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c" &&
      !target.closest("input,textarea,[contenteditable=true]")
    ) {
      if (window.getSelection()?.toString()) return;
      if (active.selected.size) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void copy();
      }
    }
  };
  options.panel.addEventListener("keydown", (event) => {
    handleKey(event);
    event.stopPropagation();
  });
  window.addEventListener("keydown", handleKey);
  const refreshTranslations = () => {
    for (const translate of translations) translate();
    resize.setLabel(t("ocr.result.resize"));
    list.refresh();
    changed();
  };
  refreshTranslations();
  const cached = (path: string) => {
    const key = keyFor(path),
      result = results.get(key),
      entry = options.getEntry(path);
    if (result?.identity && (!entry || identity(entry) !== result.identity)) {
      results.delete(key);
      return undefined;
    }
    return result;
  };
  return {
    setResult(path: string, result: string | OcrDocument, entry?: ImageEntry) {
      results.delete(keyFor(path));
      results.set(keyFor(path), {
        session: createOcrSession(result),
        identity: entry && identity(entry),
      });
      while (
        results.size > 1 &&
        (results.size > 12 ||
          [...results.values()].reduce(
            (bytes, value) =>
              bytes +
              value.session.blocks.reduce(
                (sum, block) => sum + block.original.length * 4 + block.lines.length * 160,
                0,
              ),
            0,
          ) >
            32 * 1024 * 1024)
      ) {
        const oldest = results.keys().next().value;
        if (oldest === undefined) break;
        results.delete(oldest);
      }
    },
    hasResult: (path: string) => !!cached(path),
    open(entry: ImageEntry) {
      const result = cached(entry.path);
      if (!result) return false;
      active = result.session;
      browsing = false;
      options.panel.classList.remove("collapsed");
      options.panel.parentElement?.classList.add("has-ocr-panel");
      options.panel.parentElement?.classList.toggle(
        "ocr-stacked",
        options.panel.parentElement.clientWidth < 900,
      );
      list.show(active, byLine);
      overlay.show(active, entry.path);
      overlay.setMode(byLine, browsing);
      changed();
      return true;
    },
    close() {
      resize.cancel();
      overlay.show(undefined);
      list.show(undefined, byLine);
      active = undefined;
      options.panel.classList.add("collapsed");
      options.panel.parentElement?.classList.remove("has-ocr-panel", "ocr-stacked");
      window.clearTimeout(statusTimer);
      status.textContent = "";
    },
    isOpen: () => !!active,
    updateOverlay: overlay.update,
    canPan: overlay.canPan,
    allowFitPan: overlay.allowFitPan,
    refreshTranslations,
  };
}

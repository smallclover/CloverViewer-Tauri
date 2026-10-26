import type { BeautifyDocument } from "../api";
import type { Rect } from "../image-editor/geometry";
import { uiIcon } from "../ui/icons";
import { createSelectControl } from "../ui/select-control";
import { button, field, watermarkControls, type Translate } from "./controls";
import { frameControls } from "./frame-controls";
import { createLibraryControls } from "./library-controls";
import { cloneBeauty, rebaseBeauty } from "./model";
import { createBeautySessionControls } from "./session-controls";
import { createBeautyPreview } from "./preview";
import { createBeautyThumbnails } from "./thumbnails";
import { bindWatermarkInput } from "./watermark-input";

/** Nonmodal editor inspector. Changes go straight to the editor's single history and save path. */
export function createBeautyWorkspace(options: {
  workspace: HTMLElement;
  canvas: HTMLCanvasElement;
  surface: HTMLElement;
  t: Translate;
  getDocument: () => BeautifyDocument;
  getCrop: () => Rect | null;
  getTime: () => Date;
  getOutputScale: () => number;
  getWhiteBackground: () => boolean;
  isCropping: () => boolean;
  canDrag: () => boolean;
  selectTool: () => void;
  edit: (update: (d: BeautifyDocument) => void, key?: string) => void;
  undo: () => void;
  redo: () => void;
  hasChanges: () => boolean;
  getBeforeDocument: () => BeautifyDocument;
  revertRound: () => void;
  completeRound: () => void;
  onLayout: () => void;
  onOpen: (open: boolean) => void;
}) {
  const { t } = options;
  const pane = document.createElement("aside");
  pane.className = "image-editor-inspector";
  pane.id = "image-beautify-inspector";
  pane.ariaLabel = t("beautify.title");
  pane.hidden = true;
  const header = document.createElement("header");
  header.className = "beautify-inspector-header";
  const title = document.createElement("strong");
  title.textContent = t("beautify.title");
  const hide = button(header, t("beautify.hidePanel"), () => close());
  hide.innerHTML = uiIcon("close");
  hide.ariaLabel = t("beautify.hidePanel");
  hide.title = hide.ariaLabel;
  header.prepend(title);
  const tabs = document.createElement("nav");
  tabs.className = "beautify-tabs";
  tabs.ariaLabel = t("beautify.title");
  const enabledRow = document.createElement("div");
  enabledRow.className = "beautify-enable-row";
  const enabled = field(
    enabledRow,
    t("beautify.enabled"),
    options.getDocument().enabled,
    (v) =>
      edit((d) => {
        d.enabled = v === "true";
      }),
    "checkbox",
  );
  const fields = document.createElement("div");
  fields.className = "beautify-fields";
  const status = document.createElement("footer");
  status.className = "beautify-inspector-status";
  status.setAttribute("role", "status");
  const notice = document.createElement("p");
  notice.className = "beautify-notice";
  notice.hidden = true;
  notice.setAttribute("role", "alert");
  pane.append(header, tabs, enabledRow, fields, notice, status);
  options.workspace.append(pane);
  const outline = document.createElement("div");
  outline.className = "beautify-watermark-outline";
  outline.hidden = true;
  options.surface.append(outline);
  let tab = "presets",
    selected = "",
    active = false,
    loaded = false;
  let comparisonDocument: BeautifyDocument | null = null;
  let selects: ReturnType<typeof createSelectControl>[] = [];
  const size = () => {
    const crop = options.getCrop();
    return { w: crop?.w ?? options.canvas.width, h: crop?.h ?? options.canvas.height };
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    notice.textContent = message.startsWith("beautify.")
      ? t(message)
      : t("beautify.failed", { msg: message });
    notice.hidden = false;
  };
  function selectionOutline() {
    const bound = preview.watermarks().find((b) => b.id === selected);
    outline.hidden = !active || tab !== "watermarks" || !bound || preview.element.hidden;
    if (!bound || outline.hidden) return;
    const scale = Number.parseFloat(preview.element.style.width) / preview.size().w;
    Object.assign(outline.style, {
      left: `${Number.parseFloat(preview.element.style.left) + bound.x * scale}px`,
      top: `${Number.parseFloat(preview.element.style.top) + bound.y * scale}px`,
      width: `${bound.w * scale}px`,
      height: `${bound.h * scale}px`,
    });
  }
  const preview = createBeautyPreview({
    ...options,
    getDocument: () => comparisonDocument ?? options.getDocument(),
    onGeometry: options.onLayout,
    onStatus: (dimensions, error) => {
      const size = preview.size(),
        scale = options.getOutputScale();
      status.textContent = error
        ? t(error)
        : dimensions
          ? `${Math.round(size.w * scale)} × ${Math.round(size.h * scale)} px`
          : "";
      status.classList.toggle("error", !!error);
      selectionOutline();
    },
  });
  const thumbnails = createBeautyThumbnails({ source: options.canvas, ...options });
  const library = createLibraryControls({
    thumbnail: thumbnails.paint,
    t,
    fail,
    refresh: rebuild,
    getDocument: options.getDocument,
    apply: (value) => {
      actions.stopCompare();
      const { w, h } = size();
      options.edit((d) => {
        Object.assign(d, rebaseBeauty(value, w, h));
      });
      rebuild();
    },
    active: () => active,
    adjustments: (parent) =>
      frameControls({
        parent,
        t,
        document: options.getDocument(),
        edit,
        rebuild,
        fail,
        active: () => active,
      }),
  });
  function edit(update: (d: BeautifyDocument) => void, key?: string) {
    actions.stopCompare();
    options.edit(update, key);
    library.customized();
    notice.hidden = true;
    if (enabled instanceof HTMLInputElement) enabled.checked = options.getDocument().enabled;
    actions.sync();
  }
  function rebuild() {
    if (!active) return;
    actions.sync();
    const scroll = fields.scrollTop;
    for (const select of selects) select.close();
    fields.replaceChildren();
    if (enabled instanceof HTMLInputElement) enabled.checked = options.getDocument().enabled;
    if (tab === "presets") library.render(fields);
    else {
      const controls = {
        parent: fields,
        t,
        document: options.getDocument(),
        edit,
        rebuild,
        fail,
        active: () => active,
      };
      watermarkControls(controls, selected, (id) => {
        options.selectTool();
        selected = id;
        rebuild();
        selectionOutline();
      });
    }
    selects = [...fields.querySelectorAll("select")].map(createSelectControl);
    fields.scrollTop = scroll;
    for (const node of tabs.children)
      node.setAttribute("aria-pressed", String((node as HTMLElement).dataset.tab === tab));
    selectionOutline();
  }
  function close(complete = true) {
    actions.stopCompare();
    if (complete) {
      input.cancel();
      options.completeRound();
    } else input.reset();
    active = false;
    pane.hidden = true;
    outline.hidden = true;
    for (const select of selects) select.close();
    options.workspace.classList.remove("has-beautify-inspector");
    options.onOpen(false);
    options.onLayout();
  }
  const actions = createBeautySessionControls({
    parent: pane,
    t,
    changed: options.hasChanges,
    canCompare: () => active && options.hasChanges() && !options.isCropping(),
    revert: () => {
      input.cancel();
      options.revertRound();
      rebuild();
    },
    complete: () => close(),
    compare: (pressed) => {
      comparisonDocument = pressed ? cloneBeauty(options.getBeforeDocument()) : null;
      preview.refresh();
      options.onLayout();
      selectionOutline();
    },
  });
  pane.insertBefore(actions.element, status);
  const input = bindWatermarkInput({
    surface: options.surface,
    preview: preview.element,
    isActive: () => active && tab === "watermarks" && options.canDrag(),
    getDocument: options.getDocument,
    getContentSize: size,
    getRenderScale: preview.parameterScale,
    getOutputSize: preview.size,
    getBounds: preview.watermarks,
    select: (id) => {
      selected = id;
      rebuild();
    },
    edit,
    end: () => {
      rebuild();
    },
  });
  for (const name of ["presets", "watermarks"]) {
    const node = button(tabs, t(`beautify.${name}`), () => {
      tab = name;
      if (name === "watermarks") options.selectTool();
      rebuild();
    });
    node.dataset.tab = name;
  }
  pane.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      ["z", "y"].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key.toLowerCase() === "y" || event.shiftKey) options.redo();
      else options.undo();
      return;
    }
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  const refreshTranslations = () => {
    title.textContent = t("beautify.title");
    pane.ariaLabel = title.textContent;
    tabs.ariaLabel = title.textContent;
    hide.title = hide.ariaLabel = t("beautify.hidePanel");
    actions.refreshTranslations();
    const caption = enabled.parentElement?.querySelector("span");
    if (caption) caption.textContent = t("beautify.enabled");
    for (const node of tabs.children)
      (node as HTMLElement).textContent = t(`beautify.${(node as HTMLElement).dataset.tab}`);
    rebuild();
  };
  return {
    open() {
      active = true;
      pane.hidden = false;
      options.workspace.classList.add("has-beautify-inspector");
      const { w, h } = size();
      if (!w || !h) return;
      refreshTranslations();
      const total = preview.size(),
        factor = options.getOutputScale();
      status.textContent = `${Math.round(total.w * factor)} × ${Math.round(total.h * factor)} px`;
      options.onOpen(true);
      options.onLayout();
      preview.refresh(true);
      if (!loaded) {
        loaded = true;
        void library.load();
      }
    },
    close,
    isOpen: () => active,
    isDragging: input.isDragging,
    settle() {
      actions.stopCompare();
      input.cancel();
    },
    refreshSession: actions.sync,
    bounds: preview.bounds,
    layout() {
      preview.position();
      selectionOutline();
    },
    refresh(contentChanged = false) {
      if (contentChanged) thumbnails.invalidate();
      preview.refresh(contentChanged);
    },
    sync() {
      library.sync();
      rebuild();
    },
    refreshTranslations,
    reset() {
      close(false);
      preview.reset();
      thumbnails.invalidate(false);
      selected = "";
      tab = "presets";
      notice.hidden = true;
    },
  };
}

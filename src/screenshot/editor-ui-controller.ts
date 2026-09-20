import type { HelpPanel, OcrPanel } from "./panels";
import { placeSelectionOverlay } from "./overlay-layout";
import type { Pt, Rect } from "./geometry";
import type { ToolbarUi } from "./toolbar";

interface CssBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EditorUiControllerOptions {
  root: HTMLElement;
  toolbarUi: ToolbarUi;
  helpPanel: HelpPanel;
  ocrUi: OcrPanel;
  getSelection: () => Rect | null;
  getAnchor: () => Pt | null;
  toCssBox: (rect: Rect) => CssBox;
  rootBox: () => CssBox;
  monitorBox: (anchor: Rect | null) => CssBox;
  getColor: () => string;
  getCopyColorHotkey: () => string;
  getMagnifierActive: () => boolean;
}

/** Coordinates editor-only floating UI; canvas rendering and editor state stay outside. */
export function createEditorUiController(options: EditorUiControllerOptions) {
  const { toolbarUi, helpPanel, ocrUi } = options;
  const { toolbar, colorBtn, widthBtn, colorPopup, widthPopup } = toolbarUi;
  const closePopups = () => toolbarUi.closePopups();
  const updateHelp = () =>
    helpPanel.sync(options.getCopyColorHotkey(), options.getMagnifierActive());

  const positionHelp = () => {
    if (toolbar.style.display === "none") {
      helpPanel.element.style.display = "none";
      helpPanel.element.style.transform = "";
      return;
    }
    const help = helpPanel.element;
    help.style.display = "grid";
    const width = help.offsetWidth;
    const height = help.offsetHeight;
    if (!width || !height) return;
    const anchor = options.getAnchor();
    const monitor = options.monitorBox(anchor ? { x: anchor.x, y: anchor.y, w: 1, h: 1 } : null);
    const left = monitor.x + 12;
    const top = monitor.y + monitor.h - height - 12;
    help.style.left = `${Math.round(left)}px`;
    help.style.top = `${Math.round(top)}px`;
    help.style.bottom = "auto";
    const root = options.root.getBoundingClientRect();
    const bounds = toolbar.getBoundingClientRect();
    const hit =
      bounds.left - root.left < left + width &&
      bounds.right - root.left > left &&
      bounds.top - root.top < top + height &&
      bounds.bottom - root.top > top;
    help.style.transform = hit
      ? `translateY(-${Math.ceil(top + height - (bounds.top - root.top) + 8)}px)`
      : "";
  };

  const positionOcr = () => {
    const selection = options.getSelection();
    if (!selection) return;
    const point = placeSelectionOverlay(
      options.toCssBox(selection),
      options.rootBox(),
      { w: 320, h: 220 },
      "start",
    );
    const panel = ocrUi.element;
    panel.style.left = `${point.x}px`;
    panel.style.top = `${point.y}px`;
    panel.style.width = "320px";
    panel.style.height = "220px";
  };

  const sync = () => {
    const selection = options.getSelection();
    if (selection) {
      toolbar.style.display = "flex";
      const point = placeSelectionOverlay(
        options.toCssBox(selection),
        options.rootBox(),
        { w: toolbar.offsetWidth || 360, h: toolbar.offsetHeight || 44 },
        "end",
      );
      toolbar.style.left = `${point.x}px`;
      toolbar.style.top = `${point.y}px`;
    } else toolbar.style.display = "none";
    positionHelp();
    if (selection && ocrUi.element.style.display !== "none") positionOcr();
  };

  const showOcr = (text: string, isError = false) => {
    ocrUi.show(text, isError);
    positionOcr();
  };

  const openPopup = (button: HTMLElement, popup: HTMLElement, offset: number) => {
    const open = popup.classList.contains("open");
    closePopups();
    if (open) return;
    const buttonRect = button.getBoundingClientRect();
    const rootRect = options.root.getBoundingClientRect();
    popup.style.left = `${buttonRect.left - rootRect.left - offset}px`;
    popup.style.top = `${buttonRect.bottom - rootRect.top + 6}px`;
    popup.classList.add("open");
  };
  colorBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toolbarUi.syncColor(options.getColor());
    openPopup(colorBtn, colorPopup, 80);
  });
  widthBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openPopup(widthBtn, widthPopup, 40);
  });
  window.addEventListener("mousedown", (event) => {
    const target = event.target as Node;
    if (
      colorPopup.contains(target) ||
      widthPopup.contains(target) ||
      colorBtn.contains(target) ||
      widthBtn.contains(target)
    )
      return;
    closePopups();
  });

  return { closePopups, updateHelp, sync, showOcr, hideOcr: ocrUi.hide };
}

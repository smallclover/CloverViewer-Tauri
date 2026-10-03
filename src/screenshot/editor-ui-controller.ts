import type { Pt, Rect } from "./geometry";
import { placeSelectionOverlay } from "./overlay-layout";
import type { HelpPanel } from "./panels";
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
  getSelection: () => Rect | null;
  getAnchor: () => Pt | null;
  toCssBox: (rect: Rect) => CssBox;
  rootBox: () => CssBox;
  monitorBox: (anchor: Rect | null) => CssBox;
  getColor: () => string;
  getCopyColorHotkey: () => string;
  getMagnifierActive: () => boolean;
}

/** 统一调度编辑器专用的浮动 UI；画布渲染与编辑器状态都在其外。 */
export function createEditorUiController(options: EditorUiControllerOptions) {
  const { toolbarUi, helpPanel } = options;
  const { toolbar, colorBtn, widthBtn, colorPopup, widthPopup } = toolbarUi;
  const closePopups = () => toolbarUi.closePopups();
  let lastLayout: unknown[] = [];
  const updateHelp = () => {
    lastLayout = [];
    helpPanel.sync(options.getCopyColorHotkey(), options.getMagnifierActive());
  };

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

  const sync = () => {
    const selection = options.getSelection();
    const anchor = options.getAnchor();
    const monitor = options.monitorBox(anchor ? { x: anchor.x, y: anchor.y, w: 1, h: 1 } : null);
    const rootBox = options.rootBox();
    const layout = [
      selection?.x,
      selection?.y,
      selection?.w,
      selection?.h,
      monitor.x,
      monitor.y,
      monitor.w,
      monitor.h,
      rootBox.x,
      rootBox.y,
      rootBox.w,
      rootBox.h,
    ];
    if (
      layout.length === lastLayout.length &&
      layout.every((value, index) => value === lastLayout[index])
    )
      return;
    lastLayout = layout;
    if (selection) {
      toolbar.style.display = "flex";
      const point = placeSelectionOverlay(
        options.toCssBox(selection),
        rootBox,
        { w: toolbar.offsetWidth || 360, h: toolbar.offsetHeight || 44 },
        "end",
      );
      toolbar.style.left = `${point.x}px`;
      toolbar.style.top = `${point.y}px`;
    } else toolbar.style.display = "none";
    positionHelp();
  };
  const observer = new ResizeObserver(() => {
    lastLayout = [];
    sync();
  });
  observer.observe(toolbar);
  observer.observe(helpPanel.element);
  observer.observe(options.root);

  const openPopup = (button: HTMLElement, popup: HTMLElement, offset: number) => {
    const open = popup.classList.contains("open");
    closePopups();
    if (open) return;
    const buttonRect = button.getBoundingClientRect();
    const rootRect = options.root.getBoundingClientRect();
    popup.style.left = `${buttonRect.left - rootRect.left - offset}px`;
    popup.style.top = `${buttonRect.bottom - rootRect.top + 6}px`;
    popup.style.maxHeight = `${Math.max(32, rootRect.height - 16)}px`;
    popup.style.overflowY = "auto";
    popup.classList.add("open");
    const popupRect = popup.getBoundingClientRect();
    const below = buttonRect.bottom - rootRect.top + 6;
    const top =
      below + popupRect.height <= rootRect.height - 8
        ? below
        : buttonRect.top - rootRect.top - popupRect.height - 6;
    popup.style.left = `${Math.max(8, Math.min(buttonRect.left - rootRect.left - offset, rootRect.width - popupRect.width - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(top, rootRect.height - popupRect.height - 8))}px`;
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

  return { closePopups, updateHelp, sync };
}

import type { ImageEntry } from "../api";
import { setAnimatedVisibility } from "./presentation";

type ContextItem = { label: string; action: () => void } | "separator";

interface ContextMenuControllerOptions {
  grid: HTMLElement;
  stage: HTMLElement;
  isSingleView: () => boolean;
  getImageAt: (index: number) => ImageEntry | undefined;
  getActiveImage: () => ImageEntry | undefined;
  onView: (index: number) => void;
  onCopyImage: (entry: ImageEntry) => void;
  onCopyPath: (path: string) => void;
  onShare: (entry: ImageEntry) => void;
  onProperties: (entry: ImageEntry) => void;
  onBackToGrid: () => void;
  translate: (key: string) => string;
}

/** Replaces the WebView context menu with image-aware actions. */
export function createContextMenuController(options: ContextMenuControllerOptions) {
  const menu = document.getElementById("context-menu");
  if (!menu) throw new Error("Missing context-menu element");

  const hide = () => setAnimatedVisibility(menu, false, 120);
  const show = (x: number, y: number, items: ContextItem[]) => {
    menu.innerHTML = "";
    for (const item of items) {
      if (item === "separator") {
        const separator = document.createElement("div");
        separator.className = "ctx-sep";
        menu.appendChild(separator);
        continue;
      }
      const row = document.createElement("div");
      row.className = "ctx-item";
      row.textContent = item.label;
      row.addEventListener("click", () => {
        hide();
        item.action();
      });
      menu.appendChild(row);
    }
    menu.classList.remove("hidden", "is-visible");
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 6))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 6))}px`;
    requestAnimationFrame(() => menu.classList.add("is-visible"));
  };
  const actionsFor = (entry: ImageEntry, index?: number): ContextItem[] => {
    const leadingActions: ContextItem[] =
      index === undefined
        ? [
            { label: options.translate("ctx.backToGrid"), action: options.onBackToGrid },
            {
              label: options.translate("ctx.properties"),
              action: () => options.onProperties(entry),
            },
            "separator",
          ]
        : [
            { label: options.translate("ctx.view"), action: () => options.onView(index) },
            {
              label: options.translate("ctx.properties"),
              action: () => options.onProperties(entry),
            },
            "separator",
          ];
    return [
      ...leadingActions,
      { label: options.translate("ctx.copyImage"), action: () => options.onCopyImage(entry) },
      { label: options.translate("ctx.copyPath"), action: () => options.onCopyPath(entry.path) },
      "separator",
      { label: options.translate("ctx.share"), action: () => options.onShare(entry) },
    ];
  };

  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const cell = (event.target as HTMLElement).closest(".cell");
    if (cell && options.grid.contains(cell)) {
      const index = Number((cell as HTMLElement).dataset.index);
      const entry = options.getImageAt(index);
      if (entry) show(event.clientX, event.clientY, actionsFor(entry, index));
      return;
    }
    const entry = options.getActiveImage();
    if (entry && options.isSingleView() && options.stage.contains(event.target as Node)) {
      show(event.clientX, event.clientY, actionsFor(entry));
      return;
    }
    hide();
  });
  window.addEventListener("mousedown", (event) => {
    if (!menu.contains(event.target as Node)) hide();
  });
  window.addEventListener("blur", hide);
}

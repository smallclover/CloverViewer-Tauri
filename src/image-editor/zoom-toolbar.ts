import { iconSvg, UI_ICON_PATHS } from "../ui/icons";

const FIT_ICON = iconSvg(UI_ICON_PATHS.scan);
const RESET_ICON = iconSvg('<path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6"/>');

export function createEditorZoomToolbar(options: {
  container: HTMLElement;
  translate: (key: string) => string;
  zoom: (factor: number) => void;
  fit: () => void;
  actualSize: () => void;
}) {
  const element = document.createElement("div");
  element.className = "image-editor-zoom image-editor-island";
  element.setAttribute("role", "group");
  const labels = new Map<HTMLButtonElement, string>();
  let actualSizeAvailable = true;
  let cropping = false;
  const button = (key: string, content: string, action: () => void) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "image-editor-button";
    node.innerHTML = content;
    node.addEventListener("click", action);
    labels.set(node, key);
    element.append(node);
    return node;
  };
  button("editor.zoomOut", iconSvg('<path d="M5 12h14"/>'), () => options.zoom(1 / 1.2));
  const value = document.createElement("span");
  value.className = "image-editor-zoom-value";
  element.append(value);
  button("editor.zoomIn", iconSvg('<path d="M5 12h14M12 5v14"/>'), () => options.zoom(1.2));
  const fit = button("editor.showWholeHint", FIT_ICON, options.fit);
  const actual = button(
    "editor.pixelDetailHint",
    iconSvg(
      '<path d="m3 8.5 3-2.5v12M3 18h6m6-9.5 3-2.5v12m-3 0h6"/><circle cx="12" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1.1" fill="currentColor" stroke="none"/>',
    ),
    options.actualSize,
  );
  options.container.append(element);
  const refreshTranslations = () => {
    element.title = options.translate(cropping ? "editor.cropZoomHelp" : "editor.zoomHelp");
    element.ariaLabel = element.title;
    fit.innerHTML = cropping ? RESET_ICON : FIT_ICON;
    actual.hidden = cropping;
    for (const [node, key] of labels) {
      const label =
        node === actual && !actualSizeAvailable
          ? "editor.actualSizeUnavailable"
          : node === fit && cropping
            ? "editor.fitCropFrame"
            : key;
      node.title = node.ariaLabel = options.translate(label);
    }
  };
  refreshTranslations();
  return {
    refreshTranslations,
    setScale: (scale: number, state = { canActualSize: true, cropping: false }) => {
      value.textContent = `${Math.round(scale * 100)}%`;
      actual.disabled = state.cropping || !state.canActualSize;
      if (actualSizeAvailable !== state.canActualSize || cropping !== state.cropping) {
        actualSizeAvailable = state.canActualSize;
        cropping = state.cropping;
        refreshTranslations();
      }
    },
  };
}

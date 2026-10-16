import { iconSvg } from "../ui/icons";

export function createEditorZoomToolbar(options: {
  workspace: HTMLElement;
  translate: (key: string) => string;
  zoom: (factor: number) => void;
  fit: () => void;
  actualSize: () => void;
}) {
  const element = document.createElement("div");
  element.className = "image-editor-zoom image-editor-island";
  const labels = new Map<HTMLButtonElement, string>();
  const button = (key: string, content: string, action: () => void) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "image-editor-button";
    node.innerHTML = content;
    node.addEventListener("click", action);
    labels.set(node, key);
    element.append(node);
  };
  button("editor.zoomOut", iconSvg('<path d="M5 12h14"/>'), () => options.zoom(1 / 1.2));
  const value = document.createElement("span");
  value.className = "image-editor-zoom-value";
  element.append(value);
  button("editor.zoomIn", iconSvg('<path d="M5 12h14M12 5v14"/>'), () => options.zoom(1.2));
  button("menu.fit", iconSvg('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>'), options.fit);
  button("menu.actual", "1:1", options.actualSize);
  options.workspace.append(element);
  const refreshTranslations = () => {
    element.title = options.translate("editor.zoomHelp");
    for (const [node, key] of labels) node.title = node.ariaLabel = options.translate(key);
  };
  refreshTranslations();
  return {
    refreshTranslations,
    setScale: (scale: number) => {
      value.textContent = `${Math.round(scale * 100)}%`;
    },
  };
}

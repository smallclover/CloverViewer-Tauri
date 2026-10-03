import type { Tool } from "./geometry";
import { createSelectControl } from "../ui/select-control";
import { editorIcon } from "./toolbar-icons";
import {
  createAnnotationSizes,
  createPreviewAnnotationSizing,
  SIZE_LABELS,
  SIZE_PRESETS,
  sizeKind,
} from "./annotation-style";

export type EditorTool = Tool | "select" | "crop";

interface ToolbarOptions {
  workspace: HTMLElement;
  translate: (key: string) => string;
  setTool: (tool: EditorTool) => void;
  rotate: () => void;
  undo: () => void;
  redo: () => void;
  saveAs: () => void;
  overwrite: () => void;
  close: () => void;
}

const TOOLS: [EditorTool, string][] = [
  ["select", "editor.select"],
  ["crop", "editor.crop"],
  ["rect", "shot.rect"],
  ["circle", "shot.circle"],
  ["arrow", "shot.arrow"],
  ["pen", "shot.pen"],
  ["mosaic", "shot.mosaic"],
  ["text", "shot.text"],
];

/** 底部编辑工具岛及其上下文控件；图片状态仍由控制器持有。 */
export function createEditorToolbar(options: ToolbarOptions) {
  const element = document.createElement("div");
  element.className = "image-editor-controls";
  const dock = document.createElement("div");
  dock.className = "image-editor-dock";
  const buttons = new Map<string, HTMLButtonElement>();
  const labels = new Map<HTMLElement, string>();
  let activeTool: EditorTool = "select";
  const sizes = createAnnotationSizes();
  let sizePresets = SIZE_PRESETS;

  const translated = (tag: "span" | "strong", key: string) => {
    const node = document.createElement(tag);
    labels.set(node, key);
    return node;
  };
  const group = (name: string, key: string) => {
    const node = document.createElement("div");
    node.className = `image-editor-island image-editor-${name}`;
    node.setAttribute("role", "group");
    labels.set(node, key);
    dock.append(node);
    return node;
  };
  const button = (parent: HTMLElement, key: string, action: () => void, text = false) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "image-editor-button";
    node.dataset.key = key;
    node.innerHTML = editorIcon(key);
    if (text) node.append(translated("span", key));
    node.addEventListener("click", action);
    buttons.set(key, node);
    parent.append(node);
    return node;
  };
  const divider = (parent: HTMLElement) => {
    const node = document.createElement("span");
    node.className = "image-editor-divider";
    parent.append(node);
  };

  const history = group("history", "editor.history");
  const undo = button(history, "editor.undo", options.undo);
  const redo = button(history, "editor.redo", options.redo);
  divider(history);
  button(history, "editor.cancel", options.close);
  const tools = group("tools", "editor.tools");
  tools.setAttribute("role", "toolbar");
  for (const [tool, key] of TOOLS) {
    if (tool === "rect") divider(tools);
    button(tools, key, () => options.setTool(tool)).classList.add("image-editor-tool");
  }

  const context = document.createElement("div");
  context.className = "image-editor-context image-editor-island";
  const contextName = document.createElement("strong");
  contextName.className = "image-editor-context-name";
  const hint = document.createElement("span");
  hint.className = "image-editor-context-hint";
  labels.set(hint, "editor.selectHint");
  const cropping = document.createElement("div");
  cropping.className = "image-editor-context-fields";
  cropping.append(translated("span", "editor.freeCrop"));
  button(cropping, "editor.rotate", options.rotate, true);
  const annotation = document.createElement("div");
  annotation.className = "image-editor-context-fields";
  const field = (parent: HTMLElement, key: string, control: HTMLElement) => {
    const label = document.createElement("label");
    label.className = "image-editor-field";
    const caption = translated("span", key);
    label.append(caption, control);
    parent.append(label);
    return { label, caption };
  };
  const color = document.createElement("input");
  color.type = "color";
  color.value = "#ff0000";
  color.className = "image-editor-color";
  const colorField = field(annotation, "shot.color", color).label;
  const width = document.createElement("select");
  width.className = "image-editor-select";
  width.addEventListener("change", () => {
    sizes[sizeKind(activeTool)] = Number(width.value);
  });
  const widthCaption = field(annotation, "shot.width", width).caption;
  context.append(contextName, hint, cropping, annotation);
  element.append(context, dock);

  const saving = group("saving", "editor.saveOptions");
  const saveAs = button(
    saving,
    "editor.saveAs",
    () => {
      closePanels();
      options.saveAs();
    },
    true,
  );
  saveAs.classList.add("image-editor-save-primary");
  const popup = document.createElement("div");
  popup.className = "image-editor-save-panel";
  popup.hidden = true;
  popup.id = "image-editor-save-panel";
  popup.setAttribute("role", "group");
  const more = button(saving, "editor.saveOptions", () => {
    if (!popup.hidden) {
      closePanels();
      return;
    }
    popup.hidden = false;
    more.setAttribute("aria-expanded", "true");
  });
  more.setAttribute("aria-controls", popup.id);
  more.setAttribute("aria-expanded", "false");
  popup.append(translated("strong", "editor.saveOptions"));
  const format = document.createElement("select");
  format.className = "image-editor-select";
  for (const value of ["png", "jpeg", "webp"])
    format.append(new Option(value.toUpperCase(), value));
  field(popup, "editor.format", format);
  const outputScale = document.createElement("select");
  outputScale.className = "image-editor-select";
  for (const value of [100, 75, 50, 25]) outputScale.append(new Option(`${value}%`, String(value)));
  field(popup, "editor.scale", outputScale);
  button(
    popup,
    "editor.overwrite",
    () => {
      closePanels();
      options.overwrite();
    },
    true,
  );
  saving.append(popup);
  options.workspace.append(element);
  const selects = [width, format, outputScale].map(createSelectControl);

  function closePanels() {
    popup.hidden = true;
    more.setAttribute("aria-expanded", "false");
    for (const select of selects) select.close();
  }
  document.addEventListener("pointerdown", (event) => {
    if (popup.hidden || !(event.target instanceof Element)) return;
    if (!saving.contains(event.target) && !event.target.closest(".select-menu")) closePanels();
  });
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || popup.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    closePanels();
    more.focus();
  });

  const refreshContext = () => {
    const key = TOOLS.find(([tool]) => tool === activeTool)?.[1] ?? "editor.select";
    contextName.innerHTML = editorIcon(key);
    const name = document.createElement("span");
    name.textContent = options.translate(key);
    contextName.append(name);
    hint.hidden = activeTool !== "select";
    cropping.hidden = activeTool !== "crop";
    annotation.hidden = activeTool === "select" || activeTool === "crop";
    colorField.hidden = activeTool === "mosaic";
    const kind = sizeKind(activeTool);
    const widthKey = SIZE_LABELS[kind];
    labels.set(widthCaption, widthKey);
    widthCaption.textContent = options.translate(widthKey);
    width.title = `${options.translate(widthKey)} · ${options.translate("editor.imageSizePixels")}`;
    width.ariaLabel = width.title;
    width.replaceChildren(
      ...sizePresets[kind].map(
        (value) =>
          new Option(`${value} px`, String(value), value === sizes[kind], value === sizes[kind]),
      ),
    );
    selects[0].refresh();
  };
  const refreshTranslations = () => {
    for (const [key, node] of buttons) {
      node.title = options.translate(key);
      node.ariaLabel = node.title;
    }
    for (const [node, key] of labels) {
      if (node.getAttribute("role")) node.ariaLabel = options.translate(key);
      else node.textContent = options.translate(key);
    }
    for (const [node, key] of [
      [color, "shot.color"],
      [format, "editor.format"],
      [outputScale, "editor.scale"],
    ] as const) {
      node.title = options.translate(key);
      node.ariaLabel = node.title;
    }
    popup.ariaLabel = options.translate("editor.saveOptions");
    refreshContext();
    for (const select of selects) select.refresh();
  };
  const setActiveTool = (tool: EditorTool) => {
    closePanels();
    activeTool = tool;
    for (const [candidate, key] of TOOLS) {
      const node = buttons.get(key);
      if (!node) continue;
      node.classList.toggle("active", candidate === tool);
      node.setAttribute("aria-pressed", String(candidate === tool));
    }
    refreshContext();
  };
  const updateLayout = () => {
    if (element.offsetHeight)
      options.workspace.style.setProperty(
        "--image-editor-bottom-space",
        `${element.offsetHeight + 36}px`,
      );
  };
  new ResizeObserver(updateLayout).observe(element);
  refreshTranslations();
  setActiveTool("select");
  return {
    element,
    color,
    width,
    sizes,
    format,
    outputScale,
    setActiveTool,
    refreshTranslations,
    closePanels,
    updateLayout,
    initializeSizes: (previewScale: number) => {
      const adapted = createPreviewAnnotationSizing(previewScale);
      Object.assign(sizes, adapted.sizes);
      sizePresets = adapted.presets;
      refreshContext();
    },
    refreshHistory: (canUndo: boolean, canRedo: boolean) => {
      undo.disabled = !canUndo;
      redo.disabled = !canRedo;
    },
  };
}

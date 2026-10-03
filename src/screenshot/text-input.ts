import type { Pt, Shape } from "./geometry";
import { annotationFont } from "../image-editor/annotation-style";

interface TextStyle {
  color: string;
  strokeWidth: number;
  fontSize: number;
}

interface TextInputControllerOptions {
  uiLayer: HTMLElement;
  root: HTMLElement;
  context: CanvasRenderingContext2D;
  getCanvasSize: () => { width: number; height: number };
  getStyle: () => TextStyle;
  getScale: () => number;
  getPrompt: () => string;
  onCommit: (shape: Shape) => void;
  onRender: () => void;
}

/** 负责 textarea 的定位、聚焦时机，以及从 DOM 文本到标注图形的转换。 */
export function createTextInputController({
  uiLayer,
  root,
  context,
  getCanvasSize,
  getStyle,
  getScale,
  getPrompt,
  onCommit,
  onRender,
}: TextInputControllerOptions) {
  const element = document.createElement("textarea");
  element.id = "text-input";
  element.className = "annotation-text-input";
  element.rows = 1;
  element.wrap = "off";
  element.spellcheck = false;
  const frame = document.createElement("div");
  frame.id = "text-input-frame";
  frame.className = "annotation-text-frame";
  frame.ariaHidden = "true";
  for (const position of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    const corner = document.createElement("span");
    corner.className = `annotation-text-corner ${position}`;
    frame.appendChild(corner);
  }
  uiLayer.appendChild(element);
  uiLayer.appendChild(frame);
  let start: Pt | null = null;
  let style: TextStyle;

  const layout = () => {
    if (!start || !element.classList.contains("editing")) return;
    const rootBox = root.getBoundingClientRect();
    const canvasSize = getCanvasSize();
    if (canvasSize.width <= 0 || canvasSize.height <= 0 || !rootBox.width || !rootBox.height)
      return;
    const scaleX = rootBox.width / canvasSize.width;
    const scaleY = rootBox.height / canvasSize.height;
    const fontSize = style.fontSize / getScale();
    const lineHeight = fontSize * 1.2;
    const insetX = 9;
    const insetY = 7;
    const defaultWidth = 180;
    const defaultHeight = Math.max(44, lineHeight + insetY * 2);
    const left = Math.max(4, Math.min(start.x * scaleX - insetX, rootBox.width - defaultWidth - 8));
    const top = Math.max(
      4,
      Math.min(start.y * scaleY - insetY, rootBox.height - defaultHeight - 8),
    );
    start.x = (left + insetX) / scaleX;
    start.y = (top + insetY) / scaleY;
    const lines = element.value.split("\n");
    context.font = annotationFont(style.fontSize);
    const textWidth =
      Math.max(...lines.map((line) => context.measureText(line).width)) / getScale();
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.color = style.color;
    element.style.font = annotationFont(fontSize);
    element.style.width = `${Math.min(Math.max(defaultWidth, textWidth + insetX * 2), rootBox.width - left - 8)}px`;
    element.style.height = "auto";
    const height = Math.max(
      defaultHeight,
      lines.length * lineHeight + insetY * 2,
      element.scrollHeight + 2,
    );
    element.style.height = `${Math.min(height, rootBox.height - top - 8)}px`;
    for (const property of ["left", "top", "width", "height"] as const)
      frame.style[property] = element.style[property];
  };

  const show = (point: Pt) => {
    start = { ...point };
    style = { ...getStyle() };
    element.value = "";
    element.ariaLabel = getPrompt();
    element.placeholder = element.ariaLabel;
    element.classList.add("editing");
    layout();
    onRender();
    // 等 mouse 事件完成后再聚焦，否则 blur 会抢先关闭输入框。
    const activeStart = start;
    setTimeout(() => {
      if (start === activeStart && element.classList.contains("editing")) element.focus();
    }, 0);
  };
  element.addEventListener("input", layout);
  window.addEventListener("resize", layout);

  const commit = () => {
    if (!element.classList.contains("editing")) return;
    const text = element.value.replace(/\r/g, "");
    element.classList.remove("editing");
    if (!text.trim()) return;

    if (!start) return;
    const fontSize = style.fontSize;
    context.font = annotationFont(fontSize);
    const lines = text.split("\n");
    const width = Math.max(...lines.map((line) => context.measureText(line).width));
    onCommit({
      tool: "text",
      start,
      end: { x: start.x + width, y: start.y + lines.length * fontSize * 1.2 },
      color: style.color,
      strokeWidth: style.strokeWidth,
      fontSize,
      text,
    });
    onRender();
  };

  element.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      element.classList.remove("editing");
    }
  });
  element.addEventListener("blur", commit);

  return { element, show, commit };
}

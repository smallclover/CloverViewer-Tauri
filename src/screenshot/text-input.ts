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
  onCommit: (shape: Shape) => void;
  onRender: () => void;
}

/** Owns textarea placement, focus timing and conversion from DOM text to an annotation shape. */
export function createTextInputController({
  uiLayer,
  root,
  context,
  getCanvasSize,
  getStyle,
  getScale,
  onCommit,
  onRender,
}: TextInputControllerOptions) {
  const element = document.createElement("textarea");
  element.id = "text-input";
  uiLayer.appendChild(element);
  let start: Pt | null = null;
  let style: TextStyle;

  const show = (point: Pt) => {
    const rootBox = root.getBoundingClientRect();
    const canvasSize = getCanvasSize();
    const cssX = point.x * (rootBox.width / canvasSize.width);
    const cssY = point.y * (rootBox.height / canvasSize.height);
    start = { ...point };
    style = { ...getStyle() };
    element.value = "";
    element.style.left = `${cssX}px`;
    element.style.top = `${cssY}px`;
    element.style.color = style.color;
    element.style.font = annotationFont(style.fontSize / getScale());
    element.classList.add("editing");
    onRender();
    // 等 mouse 事件完成后再聚焦，否则 blur 会抢先关闭输入框。
    const activeStart = start;
    setTimeout(() => {
      if (start === activeStart && element.classList.contains("editing")) element.focus();
    }, 0);
  };

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

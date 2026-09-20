import type { Pt, Shape } from "./geometry";

interface TextStyle {
  color: string;
  strokeWidth: number;
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

  const show = (point: Pt) => {
    const rootBox = root.getBoundingClientRect();
    const canvasSize = getCanvasSize();
    const cssX = point.x * (rootBox.width / canvasSize.width);
    const cssY = point.y * (rootBox.height / canvasSize.height);
    const style = getStyle();
    element.value = "";
    element.style.left = `${cssX}px`;
    element.style.top = `${cssY}px`;
    element.style.color = style.color;
    element.style.fontSize = `${20 + style.strokeWidth * 2}px`;
    element.classList.add("editing");
    onRender();
    // 等 mouse 事件完成后再聚焦，否则 blur 会抢先关闭输入框。
    setTimeout(() => element.focus(), 0);
  };

  const commit = () => {
    if (!element.classList.contains("editing")) return;
    const text = element.value.replace(/\r/g, "");
    element.classList.remove("editing");
    if (!text.trim()) return;

    const rootBox = root.getBoundingClientRect();
    const canvasSize = getCanvasSize();
    const startX = Number.parseFloat(element.style.left) * (canvasSize.width / rootBox.width);
    const startY = Number.parseFloat(element.style.top) * (canvasSize.height / rootBox.height);
    const style = getStyle();
    const fontSize = (20 + style.strokeWidth * 2) * getScale();
    context.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    const lines = text.split("\n");
    const width = Math.max(...lines.map((line) => context.measureText(line).width));
    onCommit({
      tool: "text",
      start: { x: startX, y: startY },
      end: { x: startX + width, y: startY + lines.length * fontSize * 1.2 },
      color: style.color,
      strokeWidth: style.strokeWidth,
      text,
    });
    onRender();
  };

  element.addEventListener("keydown", (event) => {
    event.stopPropagation();
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

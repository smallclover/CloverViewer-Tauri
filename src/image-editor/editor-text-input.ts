import { annotationFont } from "./annotation-style";
import type { Pt, Shape } from "./geometry";

type TextStyle = { color: string; fontSize: number; strokeWidth: number };

/** 拥有文字草稿、布局、焦点与输入法事件；提交后的标注及撤销历史交给会话。 */
export function createEditorTextInput(options: {
  input: HTMLTextAreaElement;
  frame: HTMLElement;
  workspace: HTMLElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  host: Pick<Window, "addEventListener" | "setTimeout">;
  getStyle: () => TextStyle;
  onCommit: (shape: Shape) => number;
  onAdjust: (index: number) => void;
}) {
  const { input: textInput, frame: textFrame, workspace, canvas, context } = options;
  let textStart: Pt | null = null;
  let textStyle: TextStyle;
  const hideTextInput = () => {
    textStart = null;
    textInput.value = "";
    textInput.classList.add("hidden");
    textInput.classList.remove("editing");
    textFrame.classList.add("hidden");
  };
  const commitTextInput = (adjustAfter = false) => {
    const text = textInput.value.trim();
    let added: number | null = null;
    if (textStart && text) {
      context.font = annotationFont(textStyle.fontSize);
      const lines = text.split("\n");
      const textWidth = Math.max(...lines.map((line) => context.measureText(line).width));
      added = options.onCommit({
        tool: "text",
        start: textStart,
        end: {
          x: textStart.x + textWidth,
          y: textStart.y + lines.length * textStyle.fontSize * 1.2,
        },
        color: textStyle.color,
        strokeWidth: textStyle.strokeWidth,
        fontSize: textStyle.fontSize,
        text,
      });
    }
    hideTextInput();
    if (adjustAfter && added !== null) options.onAdjust(added);
  };
  const layoutTextInput = () => {
    if (!textStart) return;
    const canvasBox = canvas.getBoundingClientRect();
    const workspaceBox = workspace.getBoundingClientRect();
    const scale = canvasBox.width / canvas.width;
    if (scale <= 0) return;
    const fontSize = textStyle.fontSize * scale;
    const lineHeight = fontSize * 1.2;
    // 1px 边框 + 8px/6px 内边距；输入文字与 Canvas 的起点保持一致。
    const insetX = 9;
    const insetY = 7;
    const defaultWidth = 180;
    const defaultHeight = Math.max(44, lineHeight + insetY * 2);
    const x = canvasBox.left - workspaceBox.left + textStart.x * scale;
    const y = canvasBox.top - workspaceBox.top + textStart.y * scale;
    const left = Math.max(4, Math.min(x - insetX, workspaceBox.width - defaultWidth - 8));
    const top = Math.max(4, Math.min(y - insetY, workspaceBox.height - defaultHeight - 8));
    textStart.x = (workspaceBox.left + left + insetX - canvasBox.left) / scale;
    textStart.y = (workspaceBox.top + top + insetY - canvasBox.top) / scale;
    const lines = textInput.value.split("\n");
    context.font = annotationFont(textStyle.fontSize);
    const textWidth = Math.max(...lines.map((line) => context.measureText(line).width)) * scale;
    const maxWidth = Math.max(1, workspaceBox.width - left - 8);
    const maxHeight = Math.max(1, workspaceBox.height - top - 8);
    const width = Math.min(Math.max(defaultWidth, textWidth + insetX * 2), maxWidth);
    textInput.style.font = annotationFont(fontSize);
    textInput.style.lineHeight = "1.2";
    textInput.style.color = textStyle.color;
    textInput.style.left = `${workspace.scrollLeft + left}px`;
    textInput.style.top = `${workspace.scrollTop + top}px`;
    textInput.style.width = `${width}px`;
    // 横向溢出时也给滚动条留出高度，不让它遮住当前行。
    textInput.style.height = "auto";
    const height = Math.max(
      defaultHeight,
      lines.length * lineHeight + insetY * 2,
      textInput.scrollHeight + 2,
    );
    textInput.style.height = `${Math.min(height, maxHeight)}px`;
    for (const property of ["left", "top", "width", "height"] as const)
      textFrame.style[property] = textInput.style[property];
  };
  const beginTextInput = (point: Pt) => {
    commitTextInput();
    textStart = point;
    textStyle = options.getStyle();
    textInput.value = "";
    textInput.classList.remove("hidden");
    textInput.classList.add("editing");
    textFrame.classList.remove("hidden");
    layoutTextInput();
    // pointerdown 的默认动作要先走完，之后 textarea 才能拿到焦点，故延到下一个任务。
    options.host.setTimeout(() => {
      if (textStart === point) textInput.focus({ preventScroll: true });
    }, 0);
  };
  textInput.addEventListener("input", layoutTextInput);
  options.host.addEventListener("resize", layoutTextInput);
  textInput.addEventListener("blur", () => commitTextInput(true));
  const finishTextInput = () => {
    commitTextInput(true);
    textInput.blur();
  };
  textInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      hideTextInput();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      finishTextInput();
    }
  });

  return {
    commit: commitTextInput,
    reset: hideTextInput,
    layout: layoutTextInput,
    isEditing: () => textStart !== null,
    click: (point: Pt) => {
      if (textStart && textInput.value.trim()) finishTextInput();
      else beginTextInput(point);
    },
  };
}

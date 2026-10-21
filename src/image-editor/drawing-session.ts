import type { Pt, Shape, Tool } from "./geometry";

/** 一次绘图由一个指针拥有；预览只排队绘制，松开提交真实终点，取消不进入历史。 */
export function createDrawingSession(options: {
  canvas: HTMLCanvasElement;
  host: Pick<Window, "addEventListener">;
  isEnabled: () => boolean;
  getTool: () => Tool | "select" | "crop";
  getPoint: (event: PointerEvent) => Pt;
  getStyle: () => { color: string; strokeWidth: number; blockSize: number; arrowHeadSize: number };
  requestPaint: () => void;
  discardPaint: () => void;
  invalidate: () => void;
  render: () => void;
  commit: (shape: Shape) => number;
  adjust: (index: number) => void;
}) {
  const { canvas } = options;
  let gesture: { id: number; shape: Shape } | null = null;
  const release = (id: number) => {
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };
  const reset = () => {
    const previous = gesture;
    gesture = null;
    options.discardPaint();
    if (previous) release(previous.id);
  };
  const cancel = (event?: PointerEvent) => {
    if (!gesture || (event && event.pointerId !== gesture.id)) return;
    reset();
    options.invalidate();
    options.render();
  };
  canvas.addEventListener("pointerdown", (event) => {
    const tool = options.getTool();
    if (
      gesture ||
      !options.isEnabled() ||
      event.button !== 0 ||
      tool === "select" ||
      tool === "crop" ||
      tool === "text"
    )
      return;
    const point = options.getPoint(event);
    const style = options.getStyle();
    canvas.setPointerCapture(event.pointerId);
    gesture = {
      id: event.pointerId,
      shape: {
        tool,
        start: point,
        end: point,
        color: style.color,
        strokeWidth: style.strokeWidth,
        blockSize: tool === "mosaic" ? style.blockSize : undefined,
        arrowHeadSize: tool === "arrow" ? style.arrowHeadSize : undefined,
        points: tool === "pen" || tool === "mosaic" ? [point] : undefined,
      },
    };
    if (tool === "mosaic") {
      options.invalidate();
      options.render();
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const shape = gesture.shape;
    const point = options.getPoint(event);
    shape.end = point;
    if (shape.points) {
      const previous = shape.points[shape.points.length - 1];
      const minimum = shape.tool === "mosaic" ? 0 : 1;
      if (Math.hypot(point.x - previous.x, point.y - previous.y) >= minimum)
        shape.points.push(point);
    }
    options.requestPaint();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const shape = gesture.shape;
    // 释放捕获可能同步触发 lostpointercapture；先结束手势，避免取消刚提交的笔画。
    reset();
    const point = options.getPoint(event);
    shape.end = point;
    if (shape.points) {
      const previous = shape.points[shape.points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0) shape.points.push(point);
    }
    let added: number | null = null;
    if (
      Math.abs(shape.end.x - shape.start.x) > 1 ||
      Math.abs(shape.end.y - shape.start.y) > 1 ||
      ((shape.tool === "mosaic" || shape.tool === "pen") && (shape.points?.length ?? 0) > 1) ||
      shape.tool === "mosaic"
    ) {
      const index = options.commit(shape);
      if (shape.tool !== "pen" && shape.tool !== "mosaic") added = index;
    }
    options.invalidate();
    options.render();
    if (added !== null) options.adjust(added);
  });
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("lostpointercapture", cancel);
  options.host.addEventListener("blur", () => cancel());
  return {
    get current() {
      return gesture?.shape ?? null;
    },
    isDrawing: () => gesture !== null,
    cancel: () => cancel(),
    reset,
  };
}

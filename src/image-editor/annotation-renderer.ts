import { shapeBBox, type Pt, type Shape } from "./geometry";

function drawArrow(context: CanvasRenderingContext2D, start: Pt, end: Pt, strokeWidth: number) {
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!length) return;
  const ux = (end.x - start.x) / length;
  const uy = (end.y - start.y) / length;
  const size = 12 + strokeWidth * 2;
  context.beginPath();
  context.moveTo(end.x - ux * size - uy * size * 0.5, end.y - uy * size + ux * size * 0.5);
  context.lineTo(end.x, end.y);
  context.lineTo(end.x - ux * size + uy * size * 0.5, end.y - uy * size - ux * size * 0.5);
  context.stroke();
}

/** Draws an annotation in image pixel coordinates. Mosaic is supplied by the caller. */
export function drawAnnotation(context: CanvasRenderingContext2D, shape: Shape, scale = 1) {
  context.strokeStyle = shape.color;
  context.fillStyle = shape.color;
  context.lineWidth = shape.strokeWidth * scale;
  context.lineCap = "round";
  context.lineJoin = "round";
  const bounds = shapeBBox(shape);
  switch (shape.tool) {
    case "rect":
      context.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
      break;
    case "circle":
      context.beginPath();
      context.ellipse(
        bounds.x + bounds.w / 2,
        bounds.y + bounds.h / 2,
        bounds.w / 2,
        bounds.h / 2,
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
      break;
    case "arrow":
      drawArrow(context, shape.start, shape.end, shape.strokeWidth * scale);
      break;
    case "pen":
      if (!shape.points || shape.points.length < 2) break;
      context.beginPath();
      context.moveTo(shape.points[0].x, shape.points[0].y);
      shape.points.slice(1).forEach((point) => {
        context.lineTo(point.x, point.y);
      });
      context.stroke();
      break;
    case "text": {
      const fontSize = (20 + shape.strokeWidth * 2) * scale;
      context.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
      context.textBaseline = "top";
      (shape.text || "").split("\n").forEach((line, index) => {
        context.fillText(line, shape.start.x, shape.start.y + index * fontSize * 1.2);
      });
      break;
    }
    case "mosaic":
      break;
  }
}

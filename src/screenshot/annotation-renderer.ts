import { shapeBBox, type Pt, type Shape } from "./geometry";

function drawArrow(
  context: CanvasRenderingContext2D,
  start: Pt,
  end: Pt,
  strokeWidth: number,
  scale: number,
) {
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  const unitX = dx / length;
  const unitY = dy / length;
  const arrowSize = (12 + strokeWidth * 2) * scale;
  const perpendicularX = -unitY * arrowSize * 0.5;
  const perpendicularY = unitX * arrowSize * 0.5;
  context.beginPath();
  context.moveTo(
    end.x - unitX * arrowSize + perpendicularX,
    end.y - unitY * arrowSize + perpendicularY,
  );
  context.lineTo(end.x, end.y);
  context.lineTo(
    end.x - unitX * arrowSize - perpendicularX,
    end.y - unitY * arrowSize - perpendicularY,
  );
  context.stroke();
}

/** Draw a non-mosaic screenshot annotation with no dependency on UI state. */
export function drawAnnotation(context: CanvasRenderingContext2D, shape: Shape, scale: number) {
  const strokeWidth = shape.strokeWidth * scale;
  context.strokeStyle = shape.color;
  context.fillStyle = shape.color;
  context.lineWidth = strokeWidth;
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
      drawArrow(context, shape.start, shape.end, strokeWidth, scale);
      break;
    case "pen":
      if (shape.points && shape.points.length > 1) {
        context.beginPath();
        context.moveTo(shape.points[0].x, shape.points[0].y);
        for (let index = 1; index < shape.points.length; index += 1) {
          context.lineTo(shape.points[index].x, shape.points[index].y);
        }
        context.stroke();
      }
      break;
    case "text": {
      const fontSize = (20 + shape.strokeWidth * 2) * scale;
      context.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
      context.textBaseline = "top";
      const lineHeight = fontSize * 1.2;
      (shape.text || "").split("\n").forEach((line, index) => {
        context.fillText(line, shape.start.x, shape.start.y + index * lineHeight);
      });
      break;
    }
    case "mosaic":
      break;
  }
}

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Tool = "rect" | "circle" | "arrow" | "pen" | "mosaic" | "text";

export interface Shape {
  tool: Tool;
  start: Pt;
  end: Pt;
  color: string;
  strokeWidth: number;
  text?: string;
  points?: Pt[];
}

export function normRect(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function shapeBBox(shape: Shape): Rect {
  if ((shape.tool === "pen" || shape.tool === "mosaic") && shape.points?.length) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const point of shape.points) {
      x0 = Math.min(x0, point.x);
      y0 = Math.min(y0, point.y);
      x1 = Math.max(x1, point.x);
      y1 = Math.max(y1, point.y);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return normRect(shape.start, shape.end);
}

export function distToSegment(point: Pt, start: Pt, end: Pt): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

export function isShapeHit(shape: Shape, point: Pt, tolerance: number): boolean {
  const bounds = shapeBBox(shape);
  if (shape.tool === "arrow") return distToSegment(point, shape.start, shape.end) <= tolerance;
  const points = shape.points;
  if (shape.tool === "pen" && points && points.length > 1) {
    return points
      .slice(0, -1)
      .some((start, index) => distToSegment(point, start, points[index + 1]) <= tolerance);
  }
  if (shape.tool === "circle") {
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    const a = Math.max(bounds.w / 2, 0.1);
    const b = Math.max(bounds.h / 2, 0.1);
    const dx = point.x - cx;
    const dy = point.y - cy;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.1) return false;
    const radius = (a * b) / Math.sqrt((b * (dx / distance)) ** 2 + (a * (dy / distance)) ** 2);
    return Math.abs(distance - radius) <= tolerance;
  }
  return (
    point.x >= bounds.x - tolerance &&
    point.x <= bounds.x + bounds.w + tolerance &&
    point.y >= bounds.y - tolerance &&
    point.y <= bounds.y + bounds.h + tolerance
  );
}

export function shapeHandles(shape: Shape): Pt[] {
  const bounds = shapeBBox(shape);
  if (shape.tool === "arrow") return [shape.start, shape.end];
  if (shape.tool === "text")
    return [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.w, y: bounds.y },
      { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
      { x: bounds.x, y: bounds.y + bounds.h },
    ];
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
    { x: bounds.x, y: bounds.y + bounds.h },
    { x: cx, y: bounds.y },
    { x: bounds.x + bounds.w, y: cy },
    { x: cx, y: bounds.y + bounds.h },
    { x: bounds.x, y: cy },
  ];
}

export function cloneShape(shape: Shape): Shape {
  return {
    ...shape,
    start: { ...shape.start },
    end: { ...shape.end },
    points: shape.points?.map((point) => ({ ...point })),
  };
}

export function translateShape(shape: Shape, dx: number, dy: number) {
  shape.start.x += dx;
  shape.start.y += dy;
  shape.end.x += dx;
  shape.end.y += dy;
  for (const point of shape.points ?? []) {
    point.x += dx;
    point.y += dy;
  }
}

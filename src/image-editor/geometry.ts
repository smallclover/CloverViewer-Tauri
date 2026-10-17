/** 截图标注与图片编辑共用的几何与标注数据结构。 */
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
  fontSize?: number;
  blockSize?: number;
  text?: string;
  /** 标注选框的顺时针角度；文字、矩形和椭圆绘制时也使用此局部角度。 */
  rotation?: number;
  /** 固定的旋转支点（原图像素）；不会随包围框变化重算。 */
  rotationOrigin?: Pt;
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
  if (
    (shape.tool === "text" || shape.tool === "rect" || shape.tool === "circle") &&
    shape.rotation
  ) {
    const delta = rotateVector(
      { x: shape.end.x - shape.start.x, y: shape.end.y - shape.start.y },
      -shape.rotation,
    );
    const corner = rotateVector({ x: delta.x, y: 0 }, shape.rotation);
    const other = rotateVector({ x: 0, y: delta.y }, shape.rotation);
    if (shape.tool === "circle") {
      const angle = (shape.rotation * Math.PI) / 180;
      const a = delta.x / 2,
        b = delta.y / 2;
      const x = Math.hypot(a * Math.cos(angle), b * Math.sin(angle));
      const y = Math.hypot(a * Math.sin(angle), b * Math.cos(angle));
      return {
        x: (shape.start.x + shape.end.x) / 2 - x,
        y: (shape.start.y + shape.end.y) / 2 - y,
        w: x * 2,
        h: y * 2,
      };
    }
    const xs = [shape.start.x, shape.end.x, shape.start.x + corner.x, shape.start.x + other.x];
    const ys = [shape.start.y, shape.end.y, shape.start.y + corner.y, shape.start.y + other.y];
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }
  if ((shape.tool === "pen" || shape.tool === "mosaic") && shape.points?.length) {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const point of shape.points) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
    return {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top,
    };
  }
  return normRect(shape.start, shape.end);
}

export function rotateVector(point: Pt, angle: number): Pt {
  switch (((angle % 360) + 360) % 360) {
    case 90:
      return { x: -point.y, y: point.x };
    case 180:
      return { x: -point.x, y: -point.y };
    case 270:
      return { x: point.y, y: -point.x };
    case 0:
      return point;
    default: {
      const radians = (angle * Math.PI) / 180;
      const cos = Math.cos(radians),
        sin = Math.sin(radians);
      return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
    }
  }
}

export function rotateShapeClockwise(shape: Shape, height: number): Shape {
  const rotate = (point: Pt) => ({ x: height - point.y, y: point.x });
  return {
    ...shape,
    start: rotate(shape.start),
    end: rotate(shape.end),
    points: shape.points?.map(rotate),
    ...(shape.rotationOrigin ? { rotationOrigin: rotate(shape.rotationOrigin) } : {}),
    ...(shape.tool === "text" || shape.rotation !== undefined
      ? { rotation: ((shape.rotation ?? 0) + 90) % 360 }
      : {}),
  };
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
  if (
    (shape.tool === "text" || shape.tool === "rect" || shape.tool === "circle") &&
    shape.rotation
  ) {
    const localPoint = rotateVector(
      { x: point.x - shape.start.x, y: point.y - shape.start.y },
      -shape.rotation,
    );
    const localEnd = rotateVector(
      { x: shape.end.x - shape.start.x, y: shape.end.y - shape.start.y },
      -shape.rotation,
    );
    return isShapeHit(
      { ...shape, start: { x: 0, y: 0 }, end: localEnd, rotation: 0 },
      localPoint,
      tolerance,
    );
  }
  const bounds = shapeBBox(shape);
  if (shape.tool === "arrow") return distToSegment(point, shape.start, shape.end) <= tolerance;
  const points = shape.points;
  if (shape.tool === "pen" && points && points.length > 1)
    return points
      .slice(0, -1)
      .some((start, index) => distToSegment(point, start, points[index + 1]) <= tolerance);
  if (shape.tool === "circle") {
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.1) return false;
    const a = Math.max(bounds.w / 2, 0.1);
    const b = Math.max(bounds.h / 2, 0.1);
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

export function cloneShape(shape: Shape): Shape {
  return {
    ...shape,
    start: { ...shape.start },
    end: { ...shape.end },
    points: shape.points?.map((point) => ({ ...point })),
    ...(shape.rotationOrigin ? { rotationOrigin: { ...shape.rotationOrigin } } : {}),
  };
}

export function shapeHandles(shape: Shape): Pt[] {
  const bounds = shapeBBox(shape);
  if (shape.tool === "arrow") return [shape.start, shape.end];
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
    { x: bounds.x, y: bounds.y + bounds.h },
    { x: cx, y: bounds.y },
    { x: bounds.x, y: cy },
    { x: cx, y: bounds.y + bounds.h },
    { x: bounds.x + bounds.w, y: cy },
  ];
}

export function translateShape(shape: Shape, dx: number, dy: number) {
  shape.start.x += dx;
  shape.start.y += dy;
  shape.end.x += dx;
  shape.end.y += dy;
  if (shape.rotationOrigin) {
    shape.rotationOrigin.x += dx;
    shape.rotationOrigin.y += dy;
  }
  for (const point of shape.points ?? []) {
    point.x += dx;
    point.y += dy;
  }
}

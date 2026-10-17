import { cloneShape, rotateVector, shapeBBox, type Pt, type Shape } from "./geometry";

export function annotationRotationOrigin(shape: Shape): Pt {
  if (shape.rotationOrigin) return shape.rotationOrigin;
  const box = shapeBBox(shape);
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** 绕固定支点旋转副本；首次默认取包围盒中心，后续不会重新计算支点。 */
export function rotateAnnotation(shape: Shape, degrees: number): Shape {
  if (!Number.isFinite(degrees)) return shape;
  const angle = ((degrees % 360) + 360) % 360;
  if (angle < 1e-7 || 360 - angle < 1e-7) return shape;
  const origin = annotationRotationOrigin(shape);
  const cx = origin.x,
    cy = origin.y;
  const map = (point: { x: number; y: number }) => {
    const p = rotateVector({ x: point.x - cx, y: point.y - cy }, angle);
    return { x: cx + p.x, y: cy + p.y };
  };
  const result = cloneShape(shape);
  result.start = map(shape.start);
  result.end = map(shape.end);
  result.points = shape.points?.map(map);
  result.rotationOrigin = { ...origin };
  result.rotation = ((((shape.rotation ?? 0) + angle) % 360) + 360) % 360;
  return result;
}

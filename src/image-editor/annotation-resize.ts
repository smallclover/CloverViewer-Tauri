import { cloneShape, shapeBBox, type Pt, type Rect, type Shape } from "./geometry";
import { textFontSize } from "./annotation-style";

/** 四角缩放以对角为锚点；文字保持比例与旋转，笔画的所有点一起变换。 */
export function resizeAnnotation(
  shape: Shape,
  corner: number,
  delta: Pt,
  bounds: Rect,
  minimum: number,
): Shape {
  const original = shapeBBox(shape);
  const box = {
    x: original.x - (original.w === 0 ? 0.5 : 0),
    y: original.y - (original.h === 0 ? 0.5 : 0),
    w: original.w || 1,
    h: original.h || 1,
  };
  const left = corner === 0 || corner === 3,
    top = corner < 2;
  const anchor = { x: box.x + (left ? box.w : 0), y: box.y + (top ? box.h : 0) };
  const moving = { x: box.x + (left ? 0 : box.w), y: box.y + (top ? 0 : box.h) };
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  const x = clamp(moving.x + delta.x, bounds.x, bounds.x + bounds.w);
  const y = clamp(moving.y + delta.y, bounds.y, bounds.y + bounds.h);
  const minW = Math.min(minimum, box.w),
    minH = Math.min(minimum, box.h);
  let width = Math.max(minW, (x - anchor.x) * (left ? -1 : 1));
  let height = Math.max(minH, (y - anchor.y) * (top ? -1 : 1));
  if (
    shape.tool === "text" ||
    ((shape.tool === "rect" || shape.tool === "circle") && shape.rotation)
  ) {
    const requested =
      Math.abs(width / box.w - 1) >= Math.abs(height / box.h - 1) ? width / box.w : height / box.h;
    const maxW = (left ? anchor.x - bounds.x : bounds.x + bounds.w - anchor.x) / box.w;
    const maxH = (top ? anchor.y - bounds.y : bounds.y + bounds.h - anchor.y) / box.h;
    const scale = Math.max(
      Math.max(minW / box.w, minH / box.h),
      Math.min(Math.max(1, maxW), Math.max(1, maxH), requested),
    );
    width = box.w * scale;
    height = box.h * scale;
  }
  const sx = width / box.w,
    sy = height / box.h;
  if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) return shape;
  const origin = { x: left ? anchor.x - width : anchor.x, y: top ? anchor.y - height : anchor.y };
  const map = (p: Pt) => ({ x: origin.x + (p.x - box.x) * sx, y: origin.y + (p.y - box.y) * sy });
  const result = cloneShape(shape);
  result.start = map(shape.start);
  result.end = map(shape.end);
  result.points = shape.points?.map(map);
  if (shape.rotationOrigin) result.rotationOrigin = map(shape.rotationOrigin);
  if (shape.tool === "text") result.fontSize = Math.max(1, textFontSize(shape) * sx);
  if (shape.tool === "mosaic")
    result.blockSize = Math.max(1, (shape.blockSize ?? shape.strokeWidth) * Math.sqrt(sx * sy));
  return result;
}

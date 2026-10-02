import { normRect, type Pt, type Rect } from "./geometry";

export type CropTarget = "nw" | "ne" | "se" | "sw" | "n" | "e" | "s" | "w" | "move" | "new";
export interface CropSize {
  w: number;
  h: number;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function cropTarget(rect: Rect, point: Pt, tolerance: CropSize): CropTarget {
  const left = Math.abs(point.x - rect.x) <= tolerance.w;
  const right = Math.abs(point.x - rect.x - rect.w) <= tolerance.w;
  const top = Math.abs(point.y - rect.y) <= tolerance.h;
  const bottom = Math.abs(point.y - rect.y - rect.h) <= tolerance.h;
  if (top && left) return "nw";
  if (top && right) return "ne";
  if (bottom && right) return "se";
  if (bottom && left) return "sw";
  const insideX = point.x >= rect.x && point.x <= rect.x + rect.w;
  const insideY = point.y >= rect.y && point.y <= rect.y + rect.h;
  if (top && insideX) return "n";
  if (right && insideY) return "e";
  if (bottom && insideX) return "s";
  if (left && insideY) return "w";
  return insideX && insideY ? "move" : "new";
}

/** 全程使用源图像素：对边保持不动，且不允许裁剪框反向或越界。 */
export function dragCrop(
  origin: Rect,
  start: Pt,
  point: Pt,
  target: CropTarget,
  bounds: CropSize,
  minimum: CropSize,
): Rect {
  const x = clamp(point.x, 0, bounds.w),
    y = clamp(point.y, 0, bounds.h);
  if (target === "new") return normRect(start, { x, y });
  if (target === "move")
    return {
      ...origin,
      x: clamp(origin.x + point.x - start.x, 0, bounds.w - origin.w),
      y: clamp(origin.y + point.y - start.y, 0, bounds.h - origin.h),
    };
  let left = origin.x,
    top = origin.y,
    right = origin.x + origin.w,
    bottom = origin.y + origin.h;
  // 用位移增量计算，这样在控制点热区内任意位置都能拖动，而不会让选框跳一下。
  const dx = point.x - start.x,
    dy = point.y - start.y;
  if (target.includes("w")) left = clamp(left + dx, 0, right - Math.min(minimum.w, origin.w));
  if (target.includes("e"))
    right = clamp(right + dx, left + Math.min(minimum.w, origin.w), bounds.w);
  if (target.includes("n")) top = clamp(top + dy, 0, bottom - Math.min(minimum.h, origin.h));
  if (target.includes("s"))
    bottom = clamp(bottom + dy, top + Math.min(minimum.h, origin.h), bounds.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

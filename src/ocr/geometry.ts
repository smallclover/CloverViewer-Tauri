import type { OcrPoint } from "../api";

/** Convex polygon / axis-aligned rectangle intersection using separating axes. */
export function intersectsRect(polygon: readonly OcrPoint[], a: OcrPoint, b: OcrPoint): boolean {
  const rect = [
    { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
    { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
    { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) },
  ];
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i],
      q = polygon[(i + 1) % polygon.length];
    axes.push({ x: p.y - q.y, y: q.x - p.x });
  }
  return axes.every((axis) => {
    const project = (points: readonly OcrPoint[]) => {
      const values = points.map((p) => p.x * axis.x + p.y * axis.y);
      return [Math.min(...values), Math.max(...values)];
    };
    const [min, max] = project(polygon),
      [rmin, rmax] = project(rect);
    return min <= rmax && rmin <= max;
  });
}

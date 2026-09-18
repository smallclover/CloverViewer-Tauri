import type { Pt } from "./geometry";

/** Visit original and interpolated mosaic stamp positions in render order. */
export function forEachMosaicStamp(
  points: readonly Pt[],
  blockSize: number,
  stamp: (point: Pt) => void,
) {
  if (blockSize <= 0) return;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    stamp(current);
    if (index === 0) continue;

    const previous = points[index - 1];
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (distance <= blockSize) continue;

    const steps = Math.max(1, Math.ceil(distance / blockSize));
    for (let step = 1; step < steps; step += 1) {
      const ratio = step / steps;
      stamp({
        x: previous.x + (current.x - previous.x) * ratio,
        y: previous.y + (current.y - previous.y) * ratio,
      });
    }
  }
}

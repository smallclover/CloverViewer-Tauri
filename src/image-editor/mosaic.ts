import type { Pt } from "./geometry";

export function forEachMosaicStamp(
  points: readonly Pt[],
  blockSize: number,
  stamp: (point: Pt) => void,
) {
  if (blockSize <= 0) return;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    stamp(current);
    if (!index) continue;
    const previous = points[index - 1];
    const steps = Math.ceil(Math.hypot(current.x - previous.x, current.y - previous.y) / blockSize);
    for (let step = 1; step < steps; step += 1) {
      const ratio = step / steps;
      stamp({
        x: previous.x + (current.x - previous.x) * ratio,
        y: previous.y + (current.y - previous.y) * ratio,
      });
    }
  }
}

export interface OverlayBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayPoint {
  x: number;
  y: number;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function overlaps(a: OverlayBox, b: OverlayBox): boolean {
  return a.x + a.w > b.x && a.x < b.x + b.w && a.y + a.h > b.y && a.y < b.y + b.h;
}

export function overlapArea(a: OverlayBox, b: OverlayBox): number {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return width * height;
}

/** Position an ordinary toolbar/panel below a selection, flipping above if needed. */
export function placeSelectionOverlay(
  region: OverlayBox,
  viewport: OverlayBox,
  size: Pick<OverlayBox, "w" | "h">,
  align: "start" | "end",
): OverlayPoint {
  const margin = 8;
  const gap = 10;
  let x = align === "end" ? region.x + region.w - size.w : region.x;
  let y = region.y + region.h + gap;
  if (y + size.h > viewport.y + viewport.h) y = region.y - size.h - gap;
  x = clamp(
    x,
    viewport.x + margin,
    Math.max(viewport.x + margin, viewport.x + viewport.w - size.w - margin),
  );
  y = clamp(
    y,
    viewport.y + margin,
    Math.max(viewport.y + margin, viewport.y + viewport.h - size.h - margin),
  );
  return { x, y };
}

/**
 * Score overlay candidates around a capture region. Every long-capture state
 * shares the same right-side-first order so switching from setup to capture to
 * result does not make the panel visibly jump around.
 */
export function placeScrollOverlay(
  region: OverlayBox,
  monitor: OverlayBox,
  size: Pick<OverlayBox, "w" | "h">,
): OverlayPoint {
  const gap = 10;
  const minimumX = monitor.x + gap;
  const maximumX = Math.max(minimumX, monitor.x + monitor.w - size.w - gap);
  const minimumY = monitor.y + gap;
  const maximumY = Math.max(minimumY, monitor.y + monitor.h - size.h - gap);
  const right = region.x + region.w + gap;
  const left = region.x - size.w - gap;
  const above = region.y - size.h - gap;
  const below = region.y + region.h + gap;
  const candidates: OverlayPoint[] = [
    { x: right, y: region.y },
    { x: left, y: region.y },
    { x: region.x + region.w - size.w, y: above },
    { x: region.x + region.w - size.w, y: below },
    { x: region.x, y: above },
    { x: region.x, y: below },
  ];

  let best: { point: OverlayPoint; score: number } | null = null;
  for (const [index, candidate] of candidates.entries()) {
    const point = {
      x: clamp(candidate.x, minimumX, maximumX),
      y: clamp(candidate.y, minimumY, maximumY),
    };
    const displacement = Math.abs(point.x - candidate.x) + Math.abs(point.y - candidate.y);
    const covered = overlapArea({ ...point, ...size }, region);
    const score = covered * 10_000 + displacement * 10 + index;
    if (!best || score < best.score) best = { point, score };
  }
  return best?.point ?? { x: minimumX, y: minimumY };
}

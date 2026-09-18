import type { Pt, Shape } from "./geometry";

export interface ResizeOrigin {
  start: Pt;
  end: Pt;
  strokeWidth: number;
}

/**
 * Return a resized copy of an annotation, or null when the requested bounds
 * would be too small to keep it usable.  Keeping this independent from the
 * canvas event layer makes the handle mapping safe to exercise in unit tests.
 */
export function resizeShape(
  shape: Shape,
  origin: ResizeOrigin,
  handle: number,
  point: Pt,
  minimumSize: number,
): Shape | null {
  let start: Pt;
  let end: Pt;

  if (shape.tool === "arrow") {
    if (handle === 0) {
      start = point;
      end = origin.end;
    } else {
      start = origin.start;
      end = point;
    }
  } else if (shape.tool === "text") {
    const corners = [
      { x: origin.start.x, y: origin.start.y },
      { x: origin.end.x, y: origin.start.y },
      { x: origin.end.x, y: origin.end.y },
      { x: origin.start.x, y: origin.end.y },
    ];
    const opposite = corners[handle] ?? corners[0];
    start = { x: Math.min(opposite.x, point.x), y: Math.min(opposite.y, point.y) };
    end = { x: Math.max(opposite.x, point.x), y: Math.max(opposite.y, point.y) };
  } else {
    switch (handle) {
      case 0:
        start = point;
        end = origin.end;
        break;
      case 1:
        start = { x: origin.start.x, y: point.y };
        end = { x: point.x, y: origin.end.y };
        break;
      case 2:
        start = origin.start;
        end = point;
        break;
      case 3:
        start = { x: point.x, y: origin.start.y };
        end = { x: origin.end.x, y: point.y };
        break;
      case 4:
        start = { x: origin.start.x, y: point.y };
        end = origin.end;
        break;
      case 5:
        start = origin.start;
        end = { x: point.x, y: origin.end.y };
        break;
      case 6:
        start = origin.start;
        end = { x: origin.end.x, y: point.y };
        break;
      case 7:
        start = { x: point.x, y: origin.start.y };
        end = origin.end;
        break;
      default:
        start = origin.start;
        end = origin.end;
    }
  }

  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (width < minimumSize || height < minimumSize) return null;

  let strokeWidth = shape.strokeWidth;
  if (shape.tool === "text") {
    const originalWidth = Math.abs(origin.end.x - origin.start.x);
    if (originalWidth > 1) {
      strokeWidth = Math.max(1, Math.min(48, origin.strokeWidth * (width / originalWidth)));
    }
  }
  return { ...shape, start, end, strokeWidth };
}

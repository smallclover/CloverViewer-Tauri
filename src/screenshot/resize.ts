import type { Pt, Shape } from "./geometry";
import { textFontSize } from "../image-editor/annotation-style";

export interface ResizeOrigin {
  start: Pt;
  end: Pt;
  strokeWidth: number;
  fontSize?: number;
}

/**
 * 返回缩放后的标注副本；若目标尺寸小到不可用则返回 null。
 * 与画布事件层解耦，使手柄映射可以在单元测试里安全验证。
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
  const isLargeEnough =
    shape.tool === "arrow"
      ? Math.hypot(width, height) >= minimumSize
      : width >= minimumSize && height >= minimumSize;
  if (!isLargeEnough) return null;

  let fontSize = shape.fontSize;
  if (shape.tool === "text") {
    const originalWidth = Math.abs(origin.end.x - origin.start.x);
    if (originalWidth > 1) {
      fontSize = Math.max(1, Math.min(512, textFontSize(origin) * (width / originalWidth)));
    }
  }
  return { ...shape, start, end, fontSize };
}

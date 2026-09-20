import type { Rect } from "./geometry";

export function drawSelectionFrame(
  context: CanvasRenderingContext2D,
  rect: Rect,
  scale: number,
): void {
  const anchorSize = 8 * scale;
  const lineWidth = 3 * scale;
  const inset = scale;
  context.strokeStyle = "#00ff00";
  context.lineWidth = lineWidth;
  context.strokeRect(
    rect.x + lineWidth / 2 + inset,
    rect.y + lineWidth / 2 + inset,
    Math.max(1, rect.w - lineWidth - inset * 2),
    Math.max(1, rect.h - lineWidth - inset * 2),
  );
  if (rect.w > anchorSize * 3 && rect.h > anchorSize * 3) {
    const centerX = rect.x + rect.w / 2;
    const centerY = rect.y + rect.h / 2;
    context.fillStyle = "#00ff00";
    for (const [x, y] of [
      [rect.x + anchorSize / 2, rect.y + anchorSize / 2],
      [rect.x + rect.w - anchorSize / 2, rect.y + anchorSize / 2],
      [rect.x + rect.w - anchorSize / 2, rect.y + rect.h - anchorSize / 2],
      [rect.x + anchorSize / 2, rect.y + rect.h - anchorSize / 2],
      [centerX, rect.y + anchorSize / 2],
      [centerX, rect.y + rect.h - anchorSize / 2],
      [rect.x + anchorSize / 2, centerY],
      [rect.x + rect.w - anchorSize / 2, centerY],
    ]) {
      context.fillRect(x - anchorSize / 2, y - anchorSize / 2, anchorSize, anchorSize);
    }
  }
  const label = `${Math.round(rect.w)}x${Math.round(rect.h)}`;
  const fontSize = 13 * scale;
  context.font = `600 ${fontSize}px monospace`;
  context.textBaseline = "top";
  const textWidth = context.measureText(label).width;
  context.fillStyle = "rgba(0,0,0,0.55)";
  context.fillRect(rect.x + 4, rect.y + 4, textWidth + 8 * scale, fontSize + 6 * scale);
  context.fillStyle = "#00ff00";
  context.fillText(label, rect.x + 8, rect.y + 7);
}

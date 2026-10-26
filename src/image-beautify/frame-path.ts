import type { BeautyRect } from "./layout";

export function roundedPath(
  context: CanvasRenderingContext2D,
  rect: BeautyRect,
  radius: number | number[],
) {
  const { x, y, w, h } = rect;
  const values = typeof radius === "number" ? [radius, radius, radius, radius] : radius;
  const [tl, tr, br, bl] = values.map((r) => Math.min(Math.max(0, r), w / 2, h / 2));
  context.beginPath();
  context.moveTo(x + tl, y);
  context.lineTo(x + w - tr, y);
  context.arcTo(x + w, y, x + w, y + tr, tr);
  context.lineTo(x + w, y + h - br);
  context.arcTo(x + w, y + h, x + w - br, y + h, br);
  context.lineTo(x + bl, y + h);
  context.arcTo(x, y + h, x, y + h - bl, bl);
  context.lineTo(x, y + tl);
  context.arcTo(x, y, x + tl, y, tl);
  context.closePath();
}

export function fittedText(context: CanvasRenderingContext2D, text: string, width: number) {
  if (width <= 0) return "";
  if (context.measureText(text).width <= width) return text;
  const chars = Array.from(text);
  let left = 0,
    right = chars.length;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (context.measureText(`${chars.slice(0, middle).join("")}…`).width <= width) left = middle;
    else right = middle - 1;
  }
  return left ? `${chars.slice(0, left).join("")}…` : "";
}

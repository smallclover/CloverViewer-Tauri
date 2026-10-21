import type { Rect, Shape } from "./geometry";

/** 按原图坐标合成裁剪与标注，再统一缩小输出；显示层的框线和背景不参与导出。 */
export function composeEditedImage(options: {
  source: HTMLCanvasElement;
  crop: Rect | null;
  shapes: readonly Shape[];
  scale: number;
  drawShape: (target: CanvasRenderingContext2D, shape: Shape) => void;
}): HTMLCanvasElement {
  const { source, crop, shapes, scale, drawShape } = options;
  const bounds =
    crop && crop.w > 1 && crop.h > 1 ? crop : { x: 0, y: 0, w: source.width, h: source.height };
  const output = document.createElement("canvas");
  output.width = Math.round(bounds.w);
  output.height = Math.round(bounds.h);
  const target = output.getContext("2d");
  if (!target) throw new Error("Canvas 2D is unavailable");
  target.drawImage(
    source,
    bounds.x,
    bounds.y,
    bounds.w,
    bounds.h,
    0,
    0,
    output.width,
    output.height,
  );
  target.save();
  target.translate(-bounds.x, -bounds.y);
  for (const shape of shapes) drawShape(target, shape);
  target.restore();
  if (scale === 1) return output;

  const scaled = document.createElement("canvas");
  scaled.width = Math.max(1, Math.round(output.width * scale));
  scaled.height = Math.max(1, Math.round(output.height * scale));
  const scaledContext = scaled.getContext("2d");
  if (!scaledContext) throw new Error("Canvas 2D is unavailable");
  scaledContext.imageSmoothingEnabled = true;
  scaledContext.drawImage(output, 0, 0, scaled.width, scaled.height);
  output.width = output.height = 0;
  return scaled;
}

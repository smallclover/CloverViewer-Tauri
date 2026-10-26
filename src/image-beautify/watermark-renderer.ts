import type { BeautifyWatermark } from "../api";
import type { BeautyLayout, BeautyRect } from "./layout";
import { checkBeautySize, rotatedSize, watermarkPoint } from "./layout";
import { resolveWatermarkText } from "./model";

export interface WatermarkBounds extends BeautyRect {
  id: string;
}
const FONTS = {
  sans: '"Segoe UI", "Yu Gothic", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Yu Mincho", "SimSun", serif',
  mono: 'Consolas, "MS Gothic", "Microsoft YaHei", monospace',
};

export function drawWatermark(
  context: CanvasRenderingContext2D,
  layer: BeautifyWatermark,
  layout: BeautyLayout,
  assets: ReadonlyMap<string, HTMLImageElement>,
  time: Date,
): WatermarkBounds | null {
  const region = layout.regions[layer.region],
    scale = layout.scale;
  if (region.w < 1 || region.h < 1) throw new Error("beautify.noSpace");
  const image = layer.kind === "image" ? assets.get(layer.assetId) : null;
  if (layer.kind === "image" && !image) throw new Error("beautify.missingAsset");
  const size = Math.max(1, layer.fontSize * scale);
  context.font = `${size}px ${FONTS[layer.font]}`;
  const lines = resolveWatermarkText(layer.text, time).split("\n");
  const width = image
    ? layer.width * scale
    : Math.max(1, ...lines.map((line) => context.measureText(line).width));
  const height = image
    ? (width * image.naturalHeight) / image.naturalWidth
    : lines.length * size * 1.2;
  const extent = rotatedSize(width, height, layer.rotation);
  checkBeautySize(Math.ceil(extent.w), Math.ceil(extent.h));
  const point = watermarkPoint(region, layer, scale, extent.w, extent.h);
  if (layer.placement === "single" && (extent.w > region.w || extent.h > region.h))
    throw new Error("beautify.noSpace");
  const stamp = (x: number, y: number, rotation: number) => {
    context.save();
    context.translate(x, y);
    context.rotate((rotation * Math.PI) / 180);
    if (image) context.drawImage(image, -width / 2, -height / 2, width, height);
    else {
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = layer.color;
      context.strokeStyle = layer.color.toLowerCase() === "#000000" ? "#ffffff" : "#000000";
      context.lineWidth = layer.outline * scale * 2;
      context.lineJoin = "round";
      lines.forEach((line, i) => {
        const y = (i - (lines.length - 1) / 2) * size * 1.2;
        if (layer.outline > 0) context.strokeText(line, 0, y);
        context.fillText(line, 0, y);
      });
    }
    context.restore();
  };
  context.save();
  context.beginPath();
  context.rect(region.x, region.y, region.w, region.h);
  context.clip();
  context.globalAlpha = layer.opacity;
  try {
    if (layer.placement === "single") stamp(point.x, point.y, layer.rotation);
    else {
      const diagonal = Math.hypot(region.w, region.h) + Math.hypot(width, height);
      const stepX = Math.max(1, width + layer.gapX * scale),
        stepY = Math.max(1, height + layer.gapY * scale);
      const columns = Math.ceil(diagonal / stepX) + 2,
        rows = Math.ceil(diagonal / stepY) + 2;
      if (columns * rows > 20000) throw new Error("beautify.tooDense");
      context.translate(region.x + region.w / 2, region.y + region.h / 2);
      context.rotate((layer.rotation * Math.PI) / 180);
      for (let y = -rows / 2; y <= rows / 2; y++)
        for (let x = -columns / 2; x <= columns / 2; x++) stamp(x * stepX, y * stepY, 0);
    }
  } finally {
    context.restore();
  }
  return layer.placement === "single"
    ? {
        id: layer.id,
        x: point.x - extent.w / 2,
        y: point.y - extent.h / 2,
        w: extent.w,
        h: extent.h,
      }
    : null;
}

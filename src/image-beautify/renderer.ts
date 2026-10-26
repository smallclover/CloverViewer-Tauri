import type { BeautifyDocument } from "../api";
import { loadBeautyAssets } from "./assets";
import { beautyLayout, checkBeautySize, type BeautyLayout } from "./layout";
import { drawWatermark, type WatermarkBounds } from "./watermark-renderer";
import { roundedPath } from "./frame-path";
import { contentRadius, paintBackground, paintFrame, paintFrameEdge } from "./frame-renderer";

/** Preview uses the same full-resolution layout and text metrics, with only the target scaled. */
export function renderBeauty(options: {
  source: HTMLCanvasElement;
  document: BeautifyDocument;
  time: Date;
  assets: ReadonlyMap<string, HTMLImageElement>;
  scale?: number;
  previewLimit?: number;
  whiteBackground?: boolean;
}): { canvas: HTMLCanvasElement; layout: BeautyLayout; bounds: WatermarkBounds[] } {
  const { source, document: beauty } = options;
  checkBeautySize(source.width, source.height);
  const layout = beautyLayout(source.width, source.height, beauty);
  checkBeautySize(layout.width, layout.height);
  const factor = options.previewLimit
    ? Math.min(1, options.previewLimit / Math.max(layout.width, layout.height))
    : (options.scale ?? 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(layout.width * factor));
  canvas.height = Math.max(1, Math.round(layout.height * factor));
  checkBeautySize(canvas.width, canvas.height);
  const target = canvas.getContext("2d");
  if (!target) throw new Error("Canvas 2D is unavailable");
  const bounds: WatermarkBounds[] = [];
  try {
    target.scale(canvas.width / layout.width, canvas.height / layout.height);
    if (options.whiteBackground) {
      target.fillStyle = "#ffffff";
      target.fillRect(0, 0, layout.width, layout.height);
    }
    const { x, y, w, h } = layout.content;
    paintBackground(target, beauty, layout);
    paintFrame(target, beauty, layout, options.time, factor);
    target.save();
    roundedPath(target, layout.content, contentRadius(beauty, layout));
    target.clip();
    target.drawImage(source, x, y, w, h);
    if (beauty.enabled)
      for (const layer of beauty.watermarks) {
        if (!layer.enabled || layer.region !== "content") continue;
        const rect = drawWatermark(target, layer, layout, options.assets, options.time);
        if (rect) bounds.push(rect);
      }
    target.restore();
    paintFrameEdge(target, beauty, layout);
    if (beauty.enabled)
      for (const layer of beauty.watermarks) {
        if (!layer.enabled || layer.region === "content") continue;
        const rect = drawWatermark(target, layer, layout, options.assets, options.time);
        if (rect) bounds.push(rect);
      }
    return { canvas, layout, bounds };
  } catch (error) {
    canvas.width = canvas.height = 0;
    throw error;
  }
}

/** Takes ownership of a freshly composed content canvas and releases it after rendering. */
export async function composeBeauty(
  source: HTMLCanvasElement,
  beauty: BeautifyDocument,
  time: Date,
  scale = 1,
  whiteBackground = false,
) {
  try {
    const assets = await loadBeautyAssets(beauty);
    return renderBeauty({ source, document: beauty, time, assets, scale, whiteBackground }).canvas;
  } finally {
    source.width = source.height = 0;
  }
}

import type { BeautifyDocument } from "../api";
import type { Rect } from "../image-editor/geometry";
import { composeEditedImage } from "../image-editor/export-image";
import { loadBeautyAssets } from "./assets";
import { beautyLayout, checkBeautySize } from "./layout";
import { cloneBeauty } from "./model";
import { renderBeauty } from "./renderer";
import type { WatermarkBounds } from "./watermark-renderer";

/** Shares the editor's image coordinates and viewport; source canvas remains the input surface. */
export function createBeautyPreview(options: {
  canvas: HTMLCanvasElement;
  surface: HTMLElement;
  getDocument: () => BeautifyDocument;
  getCrop: () => Rect | null;
  isCropping: () => boolean;
  getTime: () => Date;
  getWhiteBackground?: () => boolean;
  onGeometry: () => void;
  onStatus: (size: string, error?: string) => void;
}) {
  const preview = document.createElement("canvas");
  preview.className = "image-editor-beauty-preview";
  preview.hidden = true;
  preview.ariaHidden = "true";
  options.surface.prepend(preview);
  let content: HTMLCanvasElement | null = null,
    generation = 0,
    frame = 0,
    geometry = "";
  let bounds: WatermarkBounds[] = [];
  const area = () =>
    options.getCrop() ?? { x: 0, y: 0, w: options.canvas.width, h: options.canvas.height };
  const layout = () => {
    const a = area();
    return beautyLayout(a.w, a.h, options.getDocument());
  };
  const displayBounds = (): Rect | null => {
    if (!options.getDocument().enabled || options.isCropping() || !options.canvas.width)
      return null;
    const a = area(),
      l = layout();
    return { x: a.x - l.content.x, y: a.y - l.content.y, w: l.width, h: l.height };
  };
  const position = () => {
    const box = displayBounds();
    if (!box) return;
    const scale = Number.parseFloat(options.canvas.style.width) / options.canvas.width;
    if (!Number.isFinite(scale)) return;
    Object.assign(preview.style, {
      left: `${Number.parseFloat(options.canvas.style.left) + box.x * scale}px`,
      top: `${Number.parseFloat(options.canvas.style.top) + box.y * scale}px`,
      width: `${box.w * scale}px`,
      height: `${box.h * scale}px`,
    });
  };
  const reset = () => {
    generation++;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (content) content.width = content.height = 0;
    content = null;
    bounds = [];
    geometry = "";
    preview.width = preview.height = 0;
    preview.hidden = true;
    options.canvas.style.opacity = "";
    const size = area();
    options.onStatus(size.w && size.h ? `${size.w} × ${size.h} px` : "");
  };
  const paint = async () => {
    frame = 0;
    const current = ++generation,
      beauty = cloneBeauty(options.getDocument());
    if (!beauty.enabled || options.isCropping() || !options.canvas.width) {
      reset();
      return;
    }
    try {
      const a = area();
      checkBeautySize(a.w, a.h);
      if (!content)
        content = composeEditedImage({
          source: options.canvas,
          crop: options.getCrop(),
          shapes: [],
          scale: 1,
          drawShape() {},
        });
      const source = content,
        time = options.getTime();
      const assets = new Map<string, HTMLImageElement>();
      let warning = "";
      const missing = new Set<string>();
      await Promise.all(
        beauty.watermarks
          .filter((w) => w.enabled && w.kind === "image")
          .map(async (layer) => {
            try {
              const loaded = await loadBeautyAssets({ ...beauty, watermarks: [layer] });
              for (const [id, image] of loaded) assets.set(id, image);
            } catch {
              missing.add(layer.id);
              warning = "beautify.missingAsset";
            }
          }),
      );
      if (current !== generation) return;
      const result = renderBeauty({
        source,
        document: { ...beauty, watermarks: beauty.watermarks.filter((w) => !missing.has(w.id)) },
        time,
        assets,
        previewLimit: 2400,
        whiteBackground: options.getWhiteBackground?.(),
      });
      preview.width = result.canvas.width;
      preview.height = result.canvas.height;
      preview.getContext("2d")?.drawImage(result.canvas, 0, 0);
      result.canvas.width = result.canvas.height = 0;
      preview.hidden = false;
      options.canvas.style.opacity = "0";
      bounds = result.bounds;
      const next = JSON.stringify(displayBounds());
      if (next !== geometry) {
        geometry = next;
        options.onGeometry();
      }
      position();
      options.onStatus(`${result.layout.width} × ${result.layout.height} px`, warning);
    } catch (error) {
      if (current !== generation) return;
      preview.hidden = true;
      options.canvas.style.opacity = "";
      const message = error instanceof Error ? error.message : String(error);
      options.onStatus("", message);
    }
  };
  return {
    element: preview,
    bounds: displayBounds,
    position,
    reset,
    size: () => {
      const l = layout();
      return { w: l.width, h: l.height };
    },
    parameterScale: () => layout().scale,
    watermarks: () => bounds,
    refresh(contentChanged = false) {
      generation++;
      if (contentChanged && content) {
        content.width = content.height = 0;
        content = null;
      }
      if (!options.getDocument().enabled || options.isCropping()) {
        reset();
        return;
      }
      if (!frame) frame = requestAnimationFrame(() => void paint());
    },
  };
}

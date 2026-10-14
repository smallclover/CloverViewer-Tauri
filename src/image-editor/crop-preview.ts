import type { Rect } from "./geometry";

/** 缓存两张视口大小的位图；拖动时只改彩色预览的裁剪区域。 */
export function createCropPreview(source: HTMLCanvasElement, root: HTMLElement) {
  const dim = document.createElement("canvas");
  const color = document.createElement("canvas");
  dim.className = "image-crop-preview image-crop-dim";
  color.className = "image-crop-preview image-crop-color";
  root.append(dim, color);
  const dimContext = dim.getContext("2d"),
    colorContext = color.getContext("2d");
  if (!dimContext || !colorContext) throw new Error("Canvas 2D is unavailable");
  let dirty = true;
  let regionKey = "";
  return {
    invalidate: () => {
      dirty = true;
    },
    prepare: (width: number, height: number, region: Rect) => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.ceil(width * ratio)),
        h = Math.max(1, Math.ceil(height * ratio));
      const nextRegionKey = `${region.x},${region.y},${region.w},${region.h}`;
      if (!dirty && color.width === w && color.height === h && regionKey === nextRegionKey) return;
      color.width = dim.width = w;
      color.height = dim.height = h;
      colorContext.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, w, h);
      dimContext.filter = "brightness(0.45)";
      dimContext.drawImage(color, 0, 0);
      dirty = false;
      regionKey = nextRegionKey;
    },
    clip: (top: number, right: number, bottom: number, left: number) => {
      color.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
    },
  };
}

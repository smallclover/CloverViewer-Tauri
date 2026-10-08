import type { Rect } from "./geometry";

interface Size {
  w: number;
  h: number;
}

/** 只改变显示位置和比例；裁剪与标注始终保存为原图像素。 */
export function fitCropViewport(image: Size, selection: Rect, viewport: Size) {
  if (image.w <= 0 || image.h <= 0 || selection.w <= 0 || selection.h <= 0) return null;
  // 为裁剪手柄留出空间，小图最多显示到原始尺寸。
  const width = viewport.w - 24,
    height = viewport.h - 24;
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(1, width / selection.w, height / selection.h);
  return {
    left: (viewport.w - selection.w * scale) / 2 - selection.x * scale,
    top: (viewport.h - selection.h * scale) / 2 - selection.y * scale,
    width: image.w * scale,
    height: image.h * scale,
    scale,
  };
}

interface CropViewportOptions {
  canvas: HTMLCanvasElement;
  surface: HTMLElement;
  getCrop: () => Rect | null;
  isCropping: () => boolean;
  onLayout: () => void;
}

export function createCropViewport(options: CropViewportOptions) {
  const { canvas, surface } = options;
  let dragging = false;
  const updateClip = () => {
    const crop = options.getCrop();
    canvas.style.clipPath =
      crop && !options.isCropping()
        ? `inset(${(crop.y / canvas.height) * 100}% ${((canvas.width - crop.x - crop.w) / canvas.width) * 100}% ${((canvas.height - crop.y - crop.h) / canvas.height) * 100}% ${(crop.x / canvas.width) * 100}%)`
        : "";
  };
  const updateLayout = () => {
    updateClip();
    if (dragging) return;
    const image = { w: canvas.width, h: canvas.height };
    const selection = options.getCrop() ?? { x: 0, y: 0, ...image };
    const layout = fitCropViewport(image, selection, {
      w: surface.clientWidth,
      h: surface.clientHeight,
    });
    if (!layout) return;
    Object.assign(canvas.style, {
      left: `${layout.left}px`,
      top: `${layout.top}px`,
      width: `${layout.width}px`,
      height: `${layout.height}px`,
    });
    options.onLayout();
  };
  new ResizeObserver(updateLayout).observe(surface);
  return {
    fit: updateLayout,
    begin: () => {
      dragging = true;
    },
    end: () => {
      dragging = false;
      updateLayout();
    },
  };
}

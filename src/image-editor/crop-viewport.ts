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
  onLayout: (animating: boolean) => void;
}

type ViewLayout = NonNullable<ReturnType<typeof fitCropViewport>>;

export function createCropViewport(options: CropViewportOptions) {
  const { canvas, surface } = options;
  let dragging = false;
  let displayed: ViewLayout | null = null;
  let animationFrame: number | null = null;
  let animationGeneration = 0;
  const stopAnimation = () => {
    animationGeneration++;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
  };
  const applyLayout = (layout: ViewLayout, animating: boolean) => {
    displayed = layout;
    Object.assign(canvas.style, {
      left: `${layout.left}px`,
      top: `${layout.top}px`,
      width: `${layout.width}px`,
      height: `${layout.height}px`,
    });
    // 每帧同步裁剪框和视口大小的预览，保持手柄尺寸及指针映射一致。
    options.onLayout(animating);
  };
  const updateClip = () => {
    const crop = options.getCrop();
    canvas.style.clipPath =
      crop && !options.isCropping()
        ? `inset(${(crop.y / canvas.height) * 100}% ${((canvas.width - crop.x - crop.w) / canvas.width) * 100}% ${((canvas.height - crop.y - crop.h) / canvas.height) * 100}% ${(crop.x / canvas.width) * 100}%)`
        : "";
  };
  const updateLayout = (animate = false) => {
    updateClip();
    if (dragging) return;
    stopAnimation();
    const image = { w: canvas.width, h: canvas.height };
    const selection = options.getCrop() ?? { x: 0, y: 0, ...image };
    const layout = fitCropViewport(image, selection, {
      w: surface.clientWidth,
      h: surface.clientHeight,
    });
    if (!layout) return;
    const start = displayed;
    if (
      !animate ||
      !start ||
      typeof requestAnimationFrame !== "function" ||
      (typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches) ||
      (start.left === layout.left && start.top === layout.top && start.scale === layout.scale)
    ) {
      applyLayout(layout, false);
      return;
    }
    const generation = animationGeneration;
    let startedAt: number | null = null;
    const step = (time: number) => {
      if (generation !== animationGeneration) return;
      animationFrame = null;
      startedAt ??= time;
      const progress = Math.min(1, (time - startedAt) / 220);
      const eased = 1 - (1 - progress) ** 3;
      const interpolate = (from: number, to: number) => from + (to - from) * eased;
      applyLayout(
        {
          left: interpolate(start.left, layout.left),
          top: interpolate(start.top, layout.top),
          width: interpolate(start.width, layout.width),
          height: interpolate(start.height, layout.height),
          scale: interpolate(start.scale, layout.scale),
        },
        progress < 1,
      );
      if (progress < 1) animationFrame = requestAnimationFrame(step);
    };
    animationFrame = requestAnimationFrame(step);
  };
  new ResizeObserver(() => updateLayout()).observe(surface);
  return {
    fit: () => updateLayout(),
    begin: () => {
      stopAnimation();
      dragging = true;
    },
    end: (cancelled = false) => {
      dragging = false;
      updateLayout(!cancelled);
    },
  };
}

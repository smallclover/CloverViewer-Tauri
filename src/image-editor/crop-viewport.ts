import type { Rect } from "./geometry";

interface Size {
  w: number;
  h: number;
}

/** 只改变显示位置和比例；裁剪与标注始终保存为原图像素。 */
export function fitCropViewport(image: Size, selection: Rect, viewport: Size) {
  if (image.w <= 0 || image.h <= 0 || selection.w <= 0 || selection.h <= 0) return null;
  // 为裁剪手柄留出空间，小图适度放大以便操作；不改变导出像素。
  const width = viewport.w - 24,
    height = viewport.h - 24;
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(2, width / selection.w, height / selection.h);
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
  onCropChange?: (crop: Rect) => void;
  onLayout: (animating: boolean) => void;
}

type ViewLayout = NonNullable<ReturnType<typeof fitCropViewport>>;

export function createCropViewport(options: CropViewportOptions) {
  const { canvas, surface } = options;
  let dragging = false;
  let manual = false;
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
  const selection = () => options.getCrop() ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const fixedFrame = () => {
    if (!displayed || !options.isCropping() || !options.onCropChange) return null;
    const crop = selection();
    return {
      x: displayed.left + crop.x * displayed.scale,
      y: displayed.top + crop.y * displayed.scale,
      w: crop.w * displayed.scale,
      h: crop.h * displayed.scale,
    };
  };
  const applyManualLayout = (layout: ViewLayout, frame: Rect | null) => {
    if (frame) {
      // 图像必须覆盖固定的裁剪框；平移到边缘时停止，不暴露透明空白。
      layout.left = Math.max(frame.x + frame.w - layout.width, Math.min(frame.x, layout.left));
      layout.top = Math.max(frame.y + frame.h - layout.height, Math.min(frame.y, layout.top));
      const previous = selection();
      const next = {
        x: Math.max(0, (frame.x - layout.left) / layout.scale),
        y: Math.max(0, (frame.y - layout.top) / layout.scale),
        w: Math.min(canvas.width, frame.w / layout.scale),
        h: Math.min(canvas.height, frame.h / layout.scale),
      };
      if ((["x", "y", "w", "h"] as const).some((key) => Math.abs(next[key] - previous[key]) > 1e-7))
        options.onCropChange?.(next);
    }
    applyLayout(layout, false);
  };
  const updateClip = () => {
    const crop = options.getCrop();
    canvas.style.clipPath =
      crop && !options.isCropping()
        ? `inset(${(crop.y / canvas.height) * 100}% ${((canvas.width - crop.x - crop.w) / canvas.width) * 100}% ${((canvas.height - crop.y - crop.h) / canvas.height) * 100}% ${(crop.x / canvas.width) * 100}%)`
        : "";
  };
  const updateLayout = (animate = false, preserveManual = false) => {
    updateClip();
    if (dragging) return;
    if (preserveManual && manual && displayed) {
      options.onLayout(false);
      return;
    }
    manual = false;
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
  const setScale = (
    scale: number,
    anchor = { x: surface.clientWidth / 2, y: surface.clientHeight / 2 },
    keepFrame = true,
  ) => {
    if (dragging || !displayed || !canvas.width || !Number.isFinite(scale) || scale <= 0) return;
    stopAnimation();
    manual = true;
    const frame = keepFrame ? fixedFrame() : null;
    const minimum = frame ? Math.max(frame.w / canvas.width, frame.h / canvas.height) : 0.05;
    const maximum = frame
      ? Math.min(40, frame.w / Math.min(2, canvas.width), frame.h / Math.min(2, canvas.height))
      : 40;
    const next = Math.min(maximum, Math.max(0.05, minimum, scale));
    const ratio = next / displayed.scale;
    applyManualLayout(
      {
        left: anchor.x - (anchor.x - displayed.left) * ratio,
        top: anchor.y - (anchor.y - displayed.top) * ratio,
        width: canvas.width * next,
        height: canvas.height * next,
        scale: next,
      },
      frame,
    );
  };
  new ResizeObserver(() => updateLayout(false, true)).observe(surface);
  return {
    fit: () => updateLayout(),
    refresh: () => updateLayout(false, true),
    zoomBy: (factor: number, anchor?: { x: number; y: number }) =>
      setScale((displayed?.scale ?? 1) * factor, anchor),
    // 明确的适应/原尺寸操作重设取景；普通缩放与平移保持框固定。
    actualSize: () => setScale(1, undefined, false),
    panBy: (x: number, y: number) => {
      if (dragging || !displayed || !canvas.width) return;
      stopAnimation();
      manual = true;
      applyManualLayout(
        { ...displayed, left: displayed.left + x, top: displayed.top + y },
        fixedFrame(),
      );
    },
    scale: () => displayed?.scale ?? 1,
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

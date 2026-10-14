interface SingleImageControllerOptions {
  stage: HTMLElement;
  getImage: () => HTMLImageElement;
  isActive: () => boolean;
  getZoomSensitivity: () => number;
  onChange: () => void;
}

interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

/** 负责单图画布的缩放/平移/旋转状态，以及滚轮、拖拽、双击等鼠标手势。 */
export function createSingleImageController(options: SingleImageControllerOptions) {
  let scale = 1;
  let fitMode = true;
  const pan = { x: 0, y: 0 };
  let rotation = 0;
  let flipHorizontal = false;
  let flipVertical = false;
  let dragging = false;
  let dragStart = { x: 0, y: 0 };
  let displayed: ViewTransform | null = null;
  let displayedImage: HTMLImageElement | null = null;
  let animationFrame: number | null = null;
  let animationGeneration = 0;

  const stopZoomAnimation = () => {
    animationGeneration++;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
  };

  const stopPanning = () => {
    dragging = false;
    options.stage.classList.remove("panning");
  };

  const fitScale = () => {
    const image = options.getImage();
    const rect = options.stage.getBoundingClientRect();
    if (!image.naturalWidth || !rect.width) return 1;
    const swapped = rotation % 180 !== 0;
    const width = swapped ? image.naturalHeight : image.naturalWidth;
    const height = swapped ? image.naturalWidth : image.naturalHeight;
    return Math.min(rect.width / width, rect.height / height) * 0.88;
  };

  const renderTransform = (image: HTMLImageElement, view: ViewTransform) => {
    displayed = view;
    displayedImage = image;
    const flip = `scale(${flipHorizontal ? -1 : 1}, ${flipVertical ? -1 : 1})`;
    const base = `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.scale})`;
    image.style.transform = `${base} rotate(${rotation}deg) ${flip}`;
  };

  const applyTransform = (animate = false) => {
    stopZoomAnimation();
    options.stage.classList.toggle("can-pan", !fitMode);
    const image = options.getImage();
    const target: ViewTransform = fitMode
      ? { scale: fitScale(), x: 0, y: 0 }
      : { scale, x: pan.x, y: pan.y };
    const start = displayed;
    if (
      !animate ||
      !start ||
      displayedImage !== image ||
      typeof requestAnimationFrame !== "function" ||
      (typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches) ||
      (start.scale === target.scale && start.x === target.x && start.y === target.y)
    ) {
      renderTransform(image, target);
      return;
    }
    const generation = animationGeneration;
    let startedAt: number | null = null;
    const step = (time: number) => {
      if (generation !== animationGeneration) return;
      if (options.getImage() !== image || !options.isActive()) {
        stopZoomAnimation();
        return;
      }
      animationFrame = null;
      startedAt ??= time;
      const progress = Math.min(1, (time - startedAt) / 150);
      const eased = 1 - (1 - progress) ** 3;
      const interpolate = (from: number, to: number) => from + (to - from) * eased;
      renderTransform(image, {
        scale: interpolate(start.scale, target.scale),
        x: interpolate(start.x, target.x),
        y: interpolate(start.y, target.y),
      });
      if (progress < 1) animationFrame = requestAnimationFrame(step);
    };
    animationFrame = requestAnimationFrame(step);
  };

  const reset = () => {
    stopPanning();
    scale = 1;
    fitMode = true;
    pan.x = 0;
    pan.y = 0;
    rotation = 0;
    flipHorizontal = false;
    flipVertical = false;
    applyTransform();
  };

  const actualSize = () => {
    stopPanning();
    fitMode = false;
    scale = 1;
    pan.x = 0;
    pan.y = 0;
    applyTransform(true);
    options.onChange();
  };

  const zoomToFit = () => {
    stopPanning();
    fitMode = true;
    applyTransform(true);
    options.onChange();
  };

  const rotate = () => {
    const renderedScale = fitMode ? fitScale() : scale;
    rotation = (rotation + 90) % 360;
    fitMode = false;
    scale = renderedScale;
    applyTransform();
    options.onChange();
  };

  const flip = (axis: "horizontal" | "vertical") => {
    const renderedScale = fitMode ? fitScale() : scale;
    fitMode = false;
    scale = renderedScale;
    if (axis === "horizontal") flipHorizontal = !flipHorizontal;
    else flipVertical = !flipVertical;
    applyTransform();
    options.onChange();
  };

  window.addEventListener("resize", () => {
    if (!options.isActive()) return;
    applyTransform();
    options.onChange();
  });
  options.stage.addEventListener("wheel", (event) => {
    if (!options.isActive()) return;
    event.preventDefault();
    stopPanning();
    const visible = displayedImage === options.getImage() ? displayed : null;
    if (fitMode) {
      fitMode = false;
      pan.x = visible?.x ?? 0;
      pan.y = visible?.y ?? 0;
      scale = visible?.scale ?? fitScale();
    }
    const factor = Math.exp(-event.deltaY * 0.0015 * options.getZoomSensitivity());
    const rect = options.stage.getBoundingClientRect();
    const cursorX = event.clientX - rect.left - rect.width / 2;
    const cursorY = event.clientY - rect.top - rect.height / 2;
    const nextScale = Math.min(Math.max(scale * factor, 0.05), 40);
    const ratio = nextScale / (visible?.scale ?? scale);
    pan.x = cursorX - ratio * (cursorX - (visible?.x ?? pan.x));
    pan.y = cursorY - ratio * (cursorY - (visible?.y ?? pan.y));
    scale = nextScale;
    applyTransform(true);
    options.onChange();
  });
  options.stage.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !options.isActive() || (fitMode && animationFrame === null)) return;
    if ((event.target as HTMLElement).closest("button")) return;
    stopZoomAnimation();
    if (displayed && displayedImage === options.getImage()) {
      fitMode = false;
      scale = displayed.scale;
      pan.x = displayed.x;
      pan.y = displayed.y;
    }
    dragging = true;
    options.stage.classList.add("can-pan");
    dragStart = { x: event.clientX - pan.x, y: event.clientY - pan.y };
    options.stage.classList.add("panning");
    options.onChange();
  });
  window.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    pan.x = event.clientX - dragStart.x;
    pan.y = event.clientY - dragStart.y;
    applyTransform();
  });
  window.addEventListener("mouseup", stopPanning);
  window.addEventListener("blur", stopPanning);
  options.stage.addEventListener("dblclick", () => {
    if (fitMode) actualSize();
    else zoomToFit();
  });

  return {
    applyTransform: () => applyTransform(),
    reset,
    actualSize,
    zoomToFit,
    rotate,
    flipHorizontal: () => flip("horizontal"),
    flipVertical: () => flip("vertical"),
    displayedScale: () => (fitMode ? fitScale() : scale),
  };
}

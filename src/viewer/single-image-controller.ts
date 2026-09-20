interface SingleImageControllerOptions {
  stage: HTMLElement;
  image: HTMLImageElement;
  isActive: () => boolean;
  getZoomSensitivity: () => number;
  onChange: () => void;
  playEnterAnimation: (element: HTMLElement, className?: string) => void;
}

/** Owns transform state and pointer gestures for the single-image canvas. */
export function createSingleImageController(options: SingleImageControllerOptions) {
  let scale = 1;
  let fitMode = true;
  const pan = { x: 0, y: 0 };
  let rotation = 0;
  let flipHorizontal = false;
  let flipVertical = false;
  let dragging = false;
  let dragStart = { x: 0, y: 0 };

  const fitScale = () => {
    const rect = options.stage.getBoundingClientRect();
    if (!options.image.naturalWidth || !rect.width) return 1;
    const swapped = rotation % 180 !== 0;
    const width = swapped ? options.image.naturalHeight : options.image.naturalWidth;
    const height = swapped ? options.image.naturalWidth : options.image.naturalHeight;
    return Math.min(rect.width / width, rect.height / height) * 0.88;
  };

  const applyTransform = () => {
    const flip = `scale(${flipHorizontal ? -1 : 1}, ${flipVertical ? -1 : 1})`;
    const base = fitMode
      ? `translate(-50%, -50%) scale(${fitScale()})`
      : `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${scale})`;
    options.image.style.transform = `${base} rotate(${rotation}deg) ${flip}`;
  };

  const reset = () => {
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
    fitMode = false;
    scale = 1;
    pan.x = 0;
    pan.y = 0;
    applyTransform();
    options.onChange();
  };

  const zoomToFit = () => {
    fitMode = true;
    applyTransform();
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

  options.image.addEventListener("load", () => {
    applyTransform();
    options.playEnterAnimation(options.image, "image-enter");
  });
  window.addEventListener("resize", () => {
    if (!options.isActive()) return;
    applyTransform();
    options.onChange();
  });
  options.stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (fitMode) {
      fitMode = false;
      pan.x = 0;
      pan.y = 0;
      scale = fitScale();
    }
    const factor = Math.exp(-event.deltaY * 0.0015 * options.getZoomSensitivity());
    const rect = options.stage.getBoundingClientRect();
    const cursorX = event.clientX - rect.left - rect.width / 2;
    const cursorY = event.clientY - rect.top - rect.height / 2;
    const nextScale = Math.min(Math.max(scale * factor, 0.05), 40);
    const ratio = nextScale / scale;
    pan.x = cursorX - ratio * (cursorX - pan.x);
    pan.y = cursorY - ratio * (cursorY - pan.y);
    scale = nextScale;
    applyTransform();
    options.onChange();
  });
  options.stage.addEventListener("mousedown", (event) => {
    if (!options.isActive() || fitMode) return;
    dragging = true;
    dragStart = { x: event.clientX - pan.x, y: event.clientY - pan.y };
    options.stage.classList.add("panning");
  });
  window.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    pan.x = event.clientX - dragStart.x;
    pan.y = event.clientY - dragStart.y;
    applyTransform();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    options.stage.classList.remove("panning");
  });
  options.stage.addEventListener("dblclick", () => {
    if (fitMode) actualSize();
    else zoomToFit();
  });

  return {
    applyTransform,
    reset,
    actualSize,
    zoomToFit,
    rotate,
    flipHorizontal: () => flip("horizontal"),
    flipVertical: () => flip("vertical"),
    displayedScale: () => (fitMode ? fitScale() : scale),
  };
}

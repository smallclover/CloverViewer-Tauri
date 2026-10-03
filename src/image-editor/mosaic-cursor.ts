import type { Pt } from "./geometry";

interface MosaicCursorOptions {
  surface: HTMLCanvasElement;
  layer: HTMLElement;
  getSize: () => number;
  isEnabled: (point: Pt) => boolean;
  trackPointer?: boolean;
}

/** 独立 DOM 光圈；尺寸从原图像素换算到预览，不参与绘制或导出。 */
export function createMosaicCursor({
  surface,
  layer,
  getSize,
  isEnabled,
  trackPointer = true,
}: MosaicCursorOptions) {
  const element = document.createElement("div");
  element.className = "mosaic-cursor";
  element.ariaHidden = "true";
  element.hidden = true;
  layer.append(element);
  let pointer: Pt | null = null;
  let imagePoint: Pt | null = null;
  let geometry: { surface: DOMRect; layer: DOMRect } | null = null;

  const hide = () => {
    element.hidden = true;
    surface.classList.remove("mosaic-cursor-active");
  };
  const reset = () => {
    pointer = null;
    imagePoint = null;
    geometry = null;
    hide();
  };
  const refresh = () => {
    if ((!pointer && !imagePoint) || surface.width <= 0 || surface.height <= 0) {
      hide();
      return;
    }
    geometry ??= { surface: surface.getBoundingClientRect(), layer: layer.getBoundingClientRect() };
    const box = geometry.surface;
    const physical = imagePoint ?? { x: 0, y: 0 };
    const client = pointer ?? {
      x: box.left + (physical.x * box.width) / surface.width,
      y: box.top + (physical.y * box.height) / surface.height,
    };
    if (
      box.width <= 0 ||
      box.height <= 0 ||
      client.x < box.left ||
      client.x > box.left + box.width ||
      client.y < box.top ||
      client.y > box.top + box.height ||
      (trackPointer && document.elementFromPoint(client.x, client.y) !== surface)
    ) {
      hide();
      return;
    }
    const point = imagePoint ?? {
      x: ((client.x - box.left) * surface.width) / box.width,
      y: ((client.y - box.top) * surface.height) / box.height,
    };
    const size = getSize();
    if (!isEnabled(point) || !Number.isFinite(size) || size <= 0) {
      hide();
      return;
    }
    const layerBox = geometry.layer;
    const diameter = (size * box.width) / surface.width;
    element.style.width = `${diameter}px`;
    element.style.height = `${diameter}px`;
    element.style.left = `${client.x - layerBox.left + layer.scrollLeft}px`;
    element.style.top = `${client.y - layerBox.top + layer.scrollTop}px`;
    element.hidden = false;
    surface.classList.add("mosaic-cursor-active");
  };
  const move = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
    refresh();
  };
  if (trackPointer) {
    surface.addEventListener("pointerenter", move);
    surface.addEventListener("pointermove", move);
  }
  surface.addEventListener("pointerleave", reset);
  surface.addEventListener("pointercancel", reset);
  const invalidate = () => {
    geometry = null;
    refresh();
  };
  layer.addEventListener("scroll", invalidate);
  window.addEventListener("resize", invalidate);
  new ResizeObserver(invalidate).observe(surface);
  window.addEventListener("blur", reset);
  return {
    refresh,
    reset,
    update: (point: Pt | null) => {
      imagePoint = point;
      refresh();
    },
  };
}

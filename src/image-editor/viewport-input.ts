import type { createCropViewport } from "./crop-viewport";

export function bindEditorViewportInput(options: {
  surface: HTMLElement;
  viewport: ReturnType<typeof createCropViewport>;
  isActive: () => boolean;
  isBusy: () => boolean;
  isCropping?: () => boolean;
}) {
  const { surface, viewport } = options;
  let space = false;
  let pan: { id: number; x: number; y: number } | null = null;
  const reset = () => {
    pan = null;
    space = false;
    surface.classList.remove("panning");
  };
  window.addEventListener("keydown", (event) => {
    if (
      !options.isActive() ||
      options.isBusy() ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (event.target as HTMLElement)?.closest?.("input, textarea, select, button, [contenteditable]")
    )
      return;
    if (event.key === " ") {
      space = true;
      event.preventDefault();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      viewport.zoomBy(1.2);
    } else if (event.key === "-") {
      event.preventDefault();
      viewport.zoomBy(1 / 1.2);
    } else if (event.key === "0") {
      event.preventDefault();
      viewport.fitImage();
    } else if (event.key === "1" && !options.isCropping?.()) {
      event.preventDefault();
      viewport.actualSize();
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.key === " ") space = false;
  });
  window.addEventListener("blur", reset);
  surface.addEventListener(
    "wheel",
    (event) => {
      if (!options.isActive() || options.isBusy() || pan) return;
      event.preventDefault();
      const bounds = surface.getBoundingClientRect();
      viewport.zoomBy(Math.exp(Math.max(-2, Math.min(2, -event.deltaY * 0.0015))), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    },
    { passive: false },
  );
  surface.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !options.isActive() ||
        options.isBusy() ||
        !(event.button === 1 || (event.button === 0 && space))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY };
      surface.setPointerCapture(event.pointerId);
      surface.classList.add("panning");
    },
    true,
  );
  surface.addEventListener(
    "pointermove",
    (event) => {
      if (!pan || pan.id !== event.pointerId) return;
      event.stopImmediatePropagation();
      viewport.panBy(event.clientX - pan.x, event.clientY - pan.y);
      pan.x = event.clientX;
      pan.y = event.clientY;
    },
    true,
  );
  surface.addEventListener(
    "pointerup",
    (event) => {
      if (!pan || pan.id !== event.pointerId) return;
      viewport.panBy(event.clientX - pan.x, event.clientY - pan.y);
      event.stopImmediatePropagation();
      reset();
      if (surface.hasPointerCapture(event.pointerId))
        surface.releasePointerCapture(event.pointerId);
    },
    true,
  );
  surface.addEventListener("pointercancel", reset);
  surface.addEventListener("lostpointercapture", reset);
  return { reset };
}

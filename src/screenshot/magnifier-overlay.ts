import type { Pt } from "./geometry";
import type { createMagnifierRenderer } from "./magnifier";

interface MagnifierOverlayOptions {
  root: HTMLElement;
  renderer: ReturnType<typeof createMagnifierRenderer>;
  getScale: () => number;
}

/** 放大镜只刷新固定屏幕大小的小画布，移动不触发桌面画布重绘。 */
export function createMagnifierOverlay({ root, renderer, getScale }: MagnifierOverlayOptions) {
  const canvas = document.createElement("canvas");
  canvas.className = "screenshot-magnifier-overlay";
  canvas.ariaHidden = "true";
  canvas.hidden = true;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  root.append(canvas);
  const hide = () => {
    canvas.hidden = true;
  };
  const update = (point: Pt | null) => {
    if (!point) {
      hide();
      return;
    }
    const box = renderer.getBox(point.x, point.y);
    const scale = getScale();
    const padding = 2;
    const width = box.w + padding * 2,
      height = box.h + padding * 2;
    const physicalWidth = Math.ceil(width * scale),
      physicalHeight = Math.ceil(height * scale);
    if (canvas.width !== physicalWidth || canvas.height !== physicalHeight) {
      canvas.width = physicalWidth;
      canvas.height = physicalHeight;
    }
    canvas.hidden = false;
    canvas.style.width = `${physicalWidth / scale}px`;
    canvas.style.height = `${physicalHeight / scale}px`;
    canvas.style.transform = `translate(${box.x - padding}px, ${box.y - padding}px)`;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(-(box.x - padding) * scale, -(box.y - padding) * scale);
    renderer.draw(context, point.x, point.y);
    context.restore();
  };
  return {
    update,
    hide,
    canvas,
    reset: () => {
      hide();
      canvas.width = canvas.height = 0;
      renderer.reset();
    },
  };
}

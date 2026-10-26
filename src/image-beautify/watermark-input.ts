import type { BeautifyDocument } from "../api";
import type { WatermarkBounds } from "./watermark-renderer";
import { beautyScale } from "./model";

export function bindWatermarkInput(options: {
  surface: HTMLElement;
  preview: HTMLCanvasElement;
  isActive: () => boolean;
  getDocument: () => BeautifyDocument;
  getContentSize: () => { w: number; h: number };
  getRenderScale?: () => number;
  getOutputSize: () => { w: number; h: number };
  getBounds: () => WatermarkBounds[];
  select: (id: string) => void;
  edit: (update: (d: BeautifyDocument) => void, key?: string) => void;
  end: () => void;
}) {
  let drag: {
    pointer: number;
    id: string;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    scale: number;
    moved: boolean;
  } | null = null;
  let space = false;
  const move = (event: PointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const origin = drag;
    if (!origin.moved && origin.x === event.clientX && origin.y === event.clientY) return;
    origin.moved = true;
    options.edit((d) => {
      const layer = d.watermarks.find((w) => w.id === origin.id);
      if (!layer) return;
      layer.x = Math.max(
        -32767,
        Math.min(32767, origin.offsetX + (event.clientX - origin.x) * origin.scale),
      );
      layer.y = Math.max(
        -32767,
        Math.min(32767, origin.offsetY + (event.clientY - origin.y) * origin.scale),
      );
    }, "watermark-drag");
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const cancel = () => {
    const previous = drag;
    drag = null;
    if (!previous) return;
    if (previous.moved)
      options.edit((d) => {
        const layer = d.watermarks.find((w) => w.id === previous.id);
        if (layer) {
          layer.x = previous.offsetX;
          layer.y = previous.offsetY;
        }
      }, "watermark-drag");
    if (options.surface.hasPointerCapture(previous.pointer))
      options.surface.releasePointerCapture(previous.pointer);
    options.end();
  };
  options.surface.addEventListener(
    "pointerdown",
    (event) => {
      if (!options.isActive() || event.button !== 0 || space || options.preview.hidden) return;
      const box = options.preview.getBoundingClientRect();
      const size = options.getContentSize();
      const factor =
        options.getRenderScale?.() ?? beautyScale(options.getDocument(), size.w, size.h);
      const output = options.getOutputSize();
      const x = ((event.clientX - box.left) * output.w) / box.width;
      const y = ((event.clientY - box.top) * output.h) / box.height;
      const scale = output.w / box.width;
      const hit = [...options.getBounds()]
        .reverse()
        .find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (!hit) return;
      const layer = options.getDocument().watermarks.find((w) => w.id === hit.id);
      if (!layer) return;
      options.select(layer.id);
      drag = {
        pointer: event.pointerId,
        id: layer.id,
        x: event.clientX,
        y: event.clientY,
        offsetX: layer.x,
        offsetY: layer.y,
        scale: scale / factor,
        moved: false,
      };
      options.surface.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  options.surface.addEventListener("pointermove", move, true);
  options.surface.addEventListener(
    "pointerup",
    (event) => {
      if (drag?.pointer !== event.pointerId) return;
      move(event);
      drag = null;
      options.end();
      options.surface.releasePointerCapture(event.pointerId);
    },
    true,
  );
  options.surface.addEventListener(
    "pointercancel",
    (event) => {
      if (drag?.pointer === event.pointerId) cancel();
    },
    true,
  );
  options.surface.addEventListener("lostpointercapture", (event) => {
    if (drag?.pointer === event.pointerId) cancel();
  });
  window.addEventListener("blur", () => {
    space = false;
    cancel();
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space") space = true;
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") space = false;
  });
  return {
    cancel,
    isDragging: () => !!drag,
    reset: () => {
      drag = null;
      space = false;
    },
  };
}

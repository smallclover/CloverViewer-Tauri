import { cropTarget, dragCrop, type CropTarget } from "./crop-selection";
import type { Pt, Rect } from "./geometry";
import { createFrameUpdate } from "./frame-update";
import { createCropPreview } from "./crop-preview";

interface CropOverlayOptions {
  canvas: HTMLCanvasElement;
  workspace: HTMLElement;
  getCrop: () => Rect | null;
  isActive: () => boolean;
  onBegin: () => void;
  onChange: (crop: Rect) => void;
  onEnd: (cancelled: boolean) => void;
}

interface CropLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  sx: number;
  sy: number;
  offsetX: number;
  offsetY: number;
}

const cursors: Record<CropTarget, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  move: "move",
  new: "crosshair",
};

/** 按显示尺寸绘制的裁剪框；其手柄与参考线永远不会进入导出的画布。 */
export function createCropOverlay(options: CropOverlayOptions) {
  const { canvas, workspace } = options;
  const overlay = document.createElement("div");
  overlay.className = "image-crop-overlay hidden";
  overlay.setAttribute("aria-hidden", "true");
  const preview = createCropPreview(canvas, overlay);
  const frame = document.createElement("div");
  frame.className = "image-crop-frame";
  for (const direction of ["nw", "ne", "se", "sw", "n", "e", "s", "w"]) {
    const handle = document.createElement("i");
    handle.className = `image-crop-handle image-crop-${direction}`;
    handle.dataset.cropTarget = direction;
    frame.append(handle);
  }
  const grid = document.createElement("div");
  grid.className = "image-crop-grid";
  for (const direction of ["v1", "v2", "h1", "h2"]) {
    const line = document.createElement("i");
    line.className = `image-crop-line image-crop-${direction}`;
    grid.append(line);
  }
  frame.append(grid);
  overlay.append(frame);
  workspace.append(overlay);

  const bounds = () => ({ w: canvas.width, h: canvas.height });
  const rect = () => options.getCrop() ?? { x: 0, y: 0, ...bounds() };
  let layout: CropLayout | null = null;
  const point = (event: PointerEvent, geometry: CropLayout): Pt => ({
    x: (event.clientX - geometry.left) / geometry.sx,
    y: (event.clientY - geometry.top) / geometry.sy,
  });
  const targetAt = (p: Pt, geometry: CropLayout) =>
    cropTarget(rect(), p, { w: 10 / geometry.sx, h: 10 / geometry.sy });
  let drag: { id: number; start: Pt; origin: Rect; target: CropTarget } | null = null;

  const update = () => {
    const active = options.isActive();
    overlay.classList.toggle("hidden", !active);
    overlay.classList.toggle("active", active);
    const visible = !!layout && active;
    canvas.classList.toggle("image-crop-preview-source", visible);
    if (!visible || !layout) return;
    preview.prepare(layout.width, layout.height, {
      x: -layout.offsetX / layout.sx,
      y: -layout.offsetY / layout.sy,
      w: layout.width / layout.sx,
      h: layout.height / layout.sy,
    });
    const selection = rect();
    const x = selection.x * layout.sx + layout.offsetX,
      y = selection.y * layout.sy + layout.offsetY;
    const w = selection.w * layout.sx,
      h = selection.h * layout.sy;
    Object.assign(frame.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    preview.clip(
      Math.max(0, y),
      Math.max(0, layout.width - x - w),
      Math.max(0, layout.height - y - h),
      Math.max(0, x),
    );
  };
  const refreshLayout = () => {
    const box = canvas.getBoundingClientRect(),
      parent = workspace.getBoundingClientRect();
    const left = Math.max(box.left, parent.left),
      top = Math.max(box.top, parent.top);
    const width = Math.max(0, Math.min(box.right, parent.right) - left),
      height = Math.max(0, Math.min(box.bottom, parent.bottom) - top);
    layout =
      box.width && box.height && width && height
        ? {
            left: box.left,
            top: box.top,
            width,
            height,
            sx: box.width / canvas.width,
            sy: box.height / canvas.height,
            offsetX: box.left - left,
            offsetY: box.top - top,
          }
        : null;
    Object.assign(overlay.style, {
      left: `${left - parent.left + workspace.scrollLeft}px`,
      top: `${top - parent.top + workspace.scrollTop}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    update();
  };
  const frames = createFrameUpdate<Pt>((next) => {
    if (!drag || !layout) return;
    const size = bounds();
    options.onChange(
      dragCrop(drag.origin, drag.start, next, drag.target, size, {
        w: Math.min(size.w, 24 / layout.sx),
        h: Math.min(size.h, 24 / layout.sy),
      }),
    );
  });
  const finish = (cancelled: boolean) => {
    if (!drag) return;
    if (cancelled) frames.discard();
    else frames.flush();
    const id = drag.id;
    drag = null;
    if (overlay.hasPointerCapture(id)) overlay.releasePointerCapture(id);
    options.onEnd(cancelled);
    update();
  };
  overlay.addEventListener("pointerdown", (event) => {
    if (!options.isActive() || event.button !== 0 || drag) return;
    event.preventDefault();
    refreshLayout();
    if (!layout) return;
    const start = point(event, layout),
      selection = rect();
    const handle = (event.target as HTMLElement).closest<HTMLElement>(".image-crop-handle");
    const target =
      (handle?.dataset.cropTarget as CropTarget | undefined) ?? targetAt(start, layout);
    drag = { id: event.pointerId, start, origin: { ...selection }, target };
    options.onBegin();
    overlay.setPointerCapture(event.pointerId);
    overlay.style.cursor = cursors[target];
  });
  overlay.addEventListener("pointermove", (event) => {
    if (!layout) return;
    if (drag && event.pointerId === drag.id) frames.push(point(event, layout));
    else if (!drag && options.isActive())
      overlay.style.cursor = cursors[targetAt(point(event, layout), layout)];
  });
  overlay.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!layout) {
      finish(true);
      return;
    }
    frames.push(point(event, layout));
    finish(false);
  });
  overlay.addEventListener("pointercancel", () => finish(true));
  overlay.addEventListener("lostpointercapture", () => finish(true));
  const observer = new ResizeObserver(refreshLayout);
  observer.observe(workspace);
  observer.observe(canvas);
  workspace.addEventListener("scroll", refreshLayout, { passive: true });
  return {
    update,
    refreshImage: () => {
      preview.invalidate();
      refreshLayout();
    },
    cancel: () => finish(true),
  };
}

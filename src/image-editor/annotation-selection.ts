import {
  cloneShape,
  isShapeHit,
  rotateVector,
  shapeBBox,
  translateShape,
  type Pt,
  type Rect,
  type Shape,
} from "./geometry";
import { createFrameUpdate } from "./frame-update";
import { annotationRotationOrigin, rotateAnnotation } from "./annotation-rotation";
import { annotationFrame, annotationRotationCursor } from "./annotation-frame";

const canAdjust = (shape: Shape | undefined): shape is Shape =>
  shape?.tool === "rect" ||
  shape?.tool === "circle" ||
  shape?.tool === "arrow" ||
  shape?.tool === "text";

/** 选择反馈独立于导出画布；一次拖动只提交一次历史，取消时恢复原标注。 */
export function createAnnotationSelection(options: {
  canvas: HTMLCanvasElement;
  surface: HTMLElement;
  translate: (key: string) => string;
  isActive: () => boolean;
  getShapes: () => Shape[];
  getBounds: () => Rect;
  replace: (index: number, shape: Shape) => void;
  commit: (index: number, before: Shape) => void;
  select: (selected: boolean) => void;
  render: () => void;
}) {
  const { canvas, surface } = options;
  const outline = (name: string) => {
    const node = document.createElement("div");
    node.className = `image-annotation-outline ${name}`;
    node.hidden = true;
    node.ariaHidden = "true";
    surface.append(node);
    return node;
  };
  const selectedOutline = outline("selected");
  const hoverOutline = outline("hovered");
  const pivot = document.createElement("div");
  pivot.className = "image-annotation-pivot";
  pivot.hidden = true;
  pivot.ariaHidden = "true";
  surface.append(pivot);
  const handles = [0, 1, 2, 3].map((corner) => {
    const handle = document.createElement("i");
    handle.className = `image-annotation-handle corner-${corner}`;
    selectedOutline.append(handle);
    handle.addEventListener("pointerdown", (event) => {
      if (!options.isActive() || event.button !== 0 || selected === null || drag) return;
      event.preventDefault();
      event.stopPropagation();
      begin(event, selected, corner);
    });
    return handle;
  });
  let selected: number | null = null;
  let hovered: number | null = null;
  let drag: {
    id: number;
    index: number;
    original: Shape;
    x: number;
    y: number;
    sx: number;
    sy: number;
    dx: number;
    dy: number;
    changed: boolean;
    corner: number | null;
    centerX: number;
    centerY: number;
    pointerAngle: number;
    degrees: number;
  } | null = null;
  const point = (event: PointerEvent): Pt => {
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) * canvas.width) / box.width,
      y: ((event.clientY - box.top) * canvas.height) / box.height,
    };
  };
  const hit = (event: PointerEvent) => {
    const p = point(event),
      bounds = options.getBounds();
    if (p.x < bounds.x || p.y < bounds.y || p.x > bounds.x + bounds.w || p.y > bounds.y + bounds.h)
      return null;
    const scale = canvas.getBoundingClientRect().width / canvas.width;
    const shapes = options.getShapes();
    for (let index = shapes.length - 1; index >= 0; index--) {
      const shape = shapes[index];
      if (!canAdjust(shape)) continue;
      if (isShapeHit(shape, p, Math.max(6 / scale, shape.strokeWidth / 2))) return index;
    }
    if (selected !== null && shapes[selected]) {
      const box = annotationFrame(shapes[selected]);
      const local = rotateVector(p, -box.angle);
      if (
        local.x >= box.x &&
        local.x <= box.x + box.w &&
        local.y >= box.y &&
        local.y <= box.y + box.h
      )
        return selected;
    }
    return null;
  };
  const refresh = () => {
    const box = canvas.getBoundingClientRect(),
      parent = surface.getBoundingClientRect();
    const sx = box.width / canvas.width,
      sy = box.height / canvas.height;
    const selectedShape = selected === null ? null : options.getShapes()[selected];
    pivot.hidden = !options.isActive() || !selectedShape;
    if (!pivot.hidden && selectedShape) {
      const origin = annotationRotationOrigin(selectedShape);
      Object.assign(pivot.style, {
        left: `${box.left - parent.left + origin.x * sx}px`,
        top: `${box.top - parent.top + origin.y * sy}px`,
      });
    }
    for (const [node, index] of [
      [selectedOutline, selected],
      [hoverOutline, hovered === selected ? null : hovered],
    ] as const) {
      const shape = index === null ? null : options.getShapes()[index];
      node.hidden = !options.isActive() || !shape || !sx || !sy;
      if (node.hidden || !shape) continue;
      const b = annotationFrame(shape),
        visible = options.getBounds();
      const padding = shape.tool === "text" ? 0 : (shape.blockSize ?? shape.strokeWidth) / 2;
      const px = padding + 4 / sx,
        py = padding + 4 / sy;
      const origin = rotateVector({ x: b.x - px, y: b.y - py }, b.angle);
      const axis = rotateVector({ x: 1, y: 0 }, b.angle);
      // 在选框的局部坐标系裁掉已应用裁剪之外的框线和手柄。
      const clip = [
        { x: visible.x, y: visible.y },
        { x: visible.x + visible.w, y: visible.y },
        { x: visible.x + visible.w, y: visible.y + visible.h },
        { x: visible.x, y: visible.y + visible.h },
      ].map((point) => {
        const local = rotateVector(point, -b.angle);
        return `${(local.x - b.x + px) * sx}px ${(local.y - b.y + py) * sy}px`;
      });
      Object.assign(node.style, {
        left: `${box.left - parent.left + origin.x * sx}px`,
        top: `${box.top - parent.top + origin.y * sy}px`,
        width: `${(b.w + px * 2) * sx}px`,
        height: `${(b.h + py * 2) * sy}px`,
        transformOrigin: "0 0",
        transform: `matrix(${axis.x}, ${(axis.y * sy) / sx}, ${(-axis.y * sx) / sy}, ${axis.x}, 0, 0)`,
        clipPath: `polygon(${clip.join(", ")})`,
      });
      if (node === selectedOutline) {
        handles.forEach((handle, index) => {
          const p = b.corners[index];
          handle.style.cursor = annotationRotationCursor(b.angle + index * 90);
          handle.hidden =
            p.x < visible.x ||
            p.x > visible.x + visible.w ||
            p.y < visible.y ||
            p.y > visible.y + visible.h;
        });
      }
    }
    if (options.isActive())
      canvas.style.cursor = drag
        ? drag.corner !== null
          ? handles[drag.corner].style.cursor
          : "grabbing"
        : hovered !== null
          ? "grab"
          : "default";
  };
  const frames = createFrameUpdate<PointerEvent>((event) => {
    if (!drag) return;
    const dx = (event.clientX - drag.x) * drag.sx,
      dy = (event.clientY - drag.y) * drag.sy;
    if (Math.hypot(dx / drag.sx, dy / drag.sy) < 3 && !drag.changed) return;
    if (drag.corner !== null) {
      const x = event.clientX - drag.centerX,
        y = event.clientY - drag.centerY;
      // 经过中心时方向没有意义，保留最后有效角度，避免突然翻转。
      if (Math.hypot(x, y) < 6) {
        drag.pointerAngle = Number.NaN;
        return;
      }
      const angle = Math.atan2(y, x);
      if (!Number.isFinite(drag.pointerAngle)) {
        drag.pointerAngle = angle;
        return;
      }
      const delta = Math.atan2(
        Math.sin(angle - drag.pointerAngle),
        Math.cos(angle - drag.pointerAngle),
      );
      drag.degrees += (delta * 180) / Math.PI;
      drag.pointerAngle = angle;
      const next = rotateAnnotation(drag.original, drag.degrees);
      drag.changed = next !== drag.original;
      options.replace(drag.index, next);
      options.render();
      return;
    }
    const bounds = options.getBounds(),
      box = shapeBBox(drag.original);
    const clamp = (value: number, low: number, high: number) =>
      Math.max(Math.min(0, low), Math.min(Math.max(0, high), value));
    drag.dx = clamp(dx, bounds.x - box.x, bounds.x + bounds.w - box.x - box.w);
    drag.dy = clamp(dy, bounds.y - box.y, bounds.y + bounds.h - box.y - box.h);
    drag.changed = drag.dx !== 0 || drag.dy !== 0;
    const next = cloneShape(drag.original);
    translateShape(next, drag.dx, drag.dy);
    options.replace(drag.index, next);
    options.render();
  });
  const finish = (cancelled: boolean) => {
    if (!drag) return;
    if (cancelled) frames.discard();
    else frames.flush();
    const previous = drag;
    drag = null;
    if (cancelled) options.replace(previous.index, previous.original);
    else if (previous.changed) options.commit(previous.index, previous.original);
    if (canvas.hasPointerCapture(previous.id)) canvas.releasePointerCapture(previous.id);
    options.render();
    refresh();
  };
  const begin = (event: PointerEvent, index: number, corner: number | null = null) => {
    const shape = options.getShapes()[index];
    if (!options.isActive() || !canAdjust(shape)) return;
    const box = canvas.getBoundingClientRect();
    const origin = annotationRotationOrigin(shape);
    const centerX = box.left + (origin.x * box.width) / canvas.width;
    const centerY = box.top + (origin.y * box.height) / canvas.height;
    drag = {
      id: event.pointerId,
      index,
      original: cloneShape(shape),
      x: event.clientX,
      y: event.clientY,
      sx: canvas.width / box.width,
      sy: canvas.height / box.height,
      dx: 0,
      dy: 0,
      changed: false,
      corner,
      centerX,
      centerY,
      pointerAngle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
      degrees: 0,
    };
    canvas.setPointerCapture(event.pointerId);
    refresh();
  };
  return {
    refresh,
    refreshTranslations: () => {
      pivot.title = options.translate("editor.rotationOriginHint");
    },
    get selected() {
      return selected;
    },
    isDragging: () => drag !== null,
    focus: (index: number) => {
      finish(true);
      selected = canAdjust(options.getShapes()[index]) ? index : null;
      hovered = null;
      options.select(selected !== null);
      refresh();
    },
    clear: () => {
      finish(true);
      selected = hovered = null;
      options.select(false);
      refresh();
    },
    cancel: (event?: PointerEvent) => {
      if (event && drag?.id !== event.pointerId) return;
      finish(true);
    },
    leave: () => {
      hovered = null;
      refresh();
    },
    down: (event: PointerEvent) => {
      if (!options.isActive() || event.button !== 0 || drag) return;
      selected = hovered = hit(event);
      options.select(selected !== null);
      if (selected !== null) {
        event.preventDefault();
        begin(event, selected);
      }
      refresh();
    },
    move: (event: PointerEvent) => {
      if (drag) {
        if (event.pointerId === drag.id) frames.push(event);
      } else {
        hovered = options.isActive() ? hit(event) : null;
        refresh();
      }
    },
    up: (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      frames.push(event);
      finish(false);
    },
  };
}

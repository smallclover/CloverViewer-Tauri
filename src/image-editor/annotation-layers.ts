import type { Pt, Rect, Shape } from "./geometry";

export type AnnotationDamage = Rect | "full" | null;

interface AnnotationLayerOptions {
  getSize: () => { width: number; height: number };
  drawShape: (context: CanvasRenderingContext2D, shape: Shape) => void;
  drawMosaicSegment: (context: CanvasRenderingContext2D, start: Pt, end: Pt, size: number) => void;
}

/** 已提交标注只在变更时重建；当前马赛克笔画每帧仅补画新增路径。 */
export function createAnnotationLayers(options: AnnotationLayerOptions) {
  const committed = document.createElement("canvas");
  const active = document.createElement("canvas");
  const committedContext = committed.getContext("2d");
  const activeContext = active.getContext("2d");
  if (!committedContext || !activeContext) throw new Error("Canvas 2D is unavailable");
  let snapshots: unknown[][] = [];
  let current: Shape | null = null;
  let activeSnapshot: unknown[] = [];
  let consumed = 0;
  let points: Pt[] | undefined;
  let hasCommitted = false;
  const merge = (a: Rect | null, b: Rect): Rect => {
    if (!a) return b;
    const x = Math.min(a.x, b.x),
      y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };
  const signature = (shape: Shape) => [
    shape,
    shape.tool,
    shape.start.x,
    shape.start.y,
    shape.end.x,
    shape.end.y,
    shape.color,
    shape.strokeWidth,
    shape.fontSize,
    shape.blockSize,
    shape.text,
    shape.points,
    shape.points?.length,
  ];
  const same = (a: readonly unknown[], b: readonly unknown[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  const reset = () => {
    committed.width = committed.height = active.width = active.height = 0;
    snapshots = [];
    current = null;
    activeSnapshot = [];
    points = undefined;
    consumed = 0;
    hasCommitted = false;
  };
  const ensureSize = (canvas: HTMLCanvasElement) => {
    const size = options.getSize();
    if (canvas.width === size.width && canvas.height === size.height) return false;
    canvas.width = size.width;
    canvas.height = size.height;
    return true;
  };
  const update = (shapes: readonly Shape[], next: Shape | null): AnnotationDamage => {
    let damage: AnnotationDamage = null;
    const nextSnapshots = shapes.map(signature);
    const changed =
      snapshots.length !== nextSnapshots.length ||
      nextSnapshots.some((value, index) => !same(value, snapshots[index] ?? []));
    if (shapes.length || snapshots.length) {
      if (ensureSize(committed) || changed) {
        committedContext.clearRect(0, 0, committed.width, committed.height);
        for (const shape of shapes) options.drawShape(committedContext, shape);
        snapshots = nextSnapshots;
        damage = "full";
      }
    }
    hasCommitted = shapes.length > 0;
    if (!next) {
      if (current) {
        activeContext.clearRect(0, 0, active.width, active.height);
        damage = "full";
      }
      current = null;
      consumed = 0;
      points = undefined;
      activeSnapshot = [];
      return damage;
    }
    const resized = ensureSize(active);
    const nextSnapshot = signature(next);
    if (next.tool === "mosaic" && next.points?.length) {
      if (
        resized ||
        next !== current ||
        next.points !== points ||
        next.points.length < consumed ||
        next.blockSize !== activeSnapshot[9]
      ) {
        activeContext.clearRect(0, 0, active.width, active.height);
        consumed = 0;
        if (current) damage = "full";
      }
      const size = next.blockSize ?? next.strokeWidth;
      for (let index = consumed; index < next.points.length; index++) {
        const start = next.points[Math.max(0, index - 1)];
        const end = next.points[index];
        options.drawMosaicSegment(activeContext, start, end, size);
        if (damage !== "full") {
          const radius = size / 2 + 1;
          const x = Math.floor(Math.min(start.x, end.x) - radius);
          const y = Math.floor(Math.min(start.y, end.y) - radius);
          damage = merge(damage, {
            x,
            y,
            w: Math.ceil(Math.max(start.x, end.x) + radius) - x,
            h: Math.ceil(Math.max(start.y, end.y) + radius) - y,
          });
        }
      }
      consumed = next.points.length;
      points = next.points;
    } else if (resized || next !== current || !same(nextSnapshot, activeSnapshot)) {
      activeContext.clearRect(0, 0, active.width, active.height);
      options.drawShape(activeContext, next);
      damage = "full";
    }
    current = next;
    activeSnapshot = nextSnapshot;
    return damage;
  };
  const paint = (target: CanvasRenderingContext2D, region?: Rect) => {
    const draw = (canvas: HTMLCanvasElement) => {
      if (region)
        target.drawImage(
          canvas,
          region.x,
          region.y,
          region.w,
          region.h,
          region.x,
          region.y,
          region.w,
          region.h,
        );
      else target.drawImage(canvas, 0, 0);
    };
    if (hasCommitted) draw(committed);
    if (current) draw(active);
  };
  return {
    reset,
    update,
    paint,
    draw(target: CanvasRenderingContext2D, shapes: readonly Shape[], next: Shape | null) {
      update(shapes, next);
      paint(target);
    },
  };
}

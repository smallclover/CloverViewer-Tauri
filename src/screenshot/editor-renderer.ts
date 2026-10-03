import { createCanvasMosaicRenderer } from "../image-editor/canvas-mosaic-renderer";
import { createAnnotationLayers } from "./annotation-layers";
import { drawAnnotation } from "./annotation-renderer";
import { type Pt, type Rect, type Shape, shapeBBox, shapeHandles } from "./geometry";
import { drawScreenBase, type ScreenImage } from "./screen-compositor";
import { drawSelectionFrame } from "./selection-frame";

export interface EditorRenderFrame {
  canvas: HTMLCanvasElement;
  selection: Rect | null;
  shapes: readonly Shape[];
  currentShape: Shape | null;
  selectedIndex: number | null;
  magnifierPoint: Pt | null;
  windowHover: Rect | null;
}

interface EditorCanvasRendererOptions {
  context: CanvasRenderingContext2D;
  getScreens: () => readonly ScreenImage[];
  getScale: () => number;
  mosaicWidth: number;
  drawMagnifier: (context: CanvasRenderingContext2D, x: number, y: number) => void;
}

/** 只负责绘制编辑器画布；所有 DOM 布局与状态切换都留在这个模块之外。 */
export function createEditorCanvasRenderer({
  context,
  getScreens,
  getScale,
  mosaicWidth,
  drawMagnifier,
}: EditorCanvasRendererOptions) {
  const sourceCanvas = document.createElement("canvas");
  const sourceContext = sourceCanvas.getContext("2d");
  if (!sourceContext) throw new Error("Canvas 2D context is unavailable");
  const mosaic = createCanvasMosaicRenderer(sourceCanvas);
  let sourceScreens: ScreenImage[] = [];
  let sourceReady = false;
  let previousFrame: unknown[] = [];
  const ensureSource = () => {
    const screens = getScreens();
    const width = Math.max(
      1,
      context.canvas?.width ?? 0,
      ...screens.map((screen) => screen.x + screen.w),
    );
    const height = Math.max(
      1,
      context.canvas?.height ?? 0,
      ...screens.map((screen) => screen.y + screen.h),
    );
    const changed =
      !sourceReady ||
      sourceCanvas.width !== width ||
      sourceCanvas.height !== height ||
      sourceScreens.length !== screens.length ||
      screens.some((screen, index) => {
        const previous = sourceScreens[index];
        return (
          !previous ||
          screen.image !== previous.image ||
          screen.x !== previous.x ||
          screen.y !== previous.y ||
          screen.w !== previous.w ||
          screen.h !== previous.h
        );
      });
    if (changed) {
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      drawScreenBase(sourceContext, screens);
      sourceScreens = screens.map((screen) => ({ ...screen }));
      sourceReady = true;
      mosaic.reset();
      layers.reset();
      previousFrame = [];
    }
  };

  const drawMosaic = (target: CanvasRenderingContext2D, shape: Shape) => {
    const points = shape.points;
    if (!points?.length) return;
    const blockSize = Math.max(
      1,
      Math.round(shape.blockSize ?? (shape.strokeWidth || mosaicWidth)),
    );
    ensureSource();
    mosaic.drawShape(target, { ...shape, blockSize });
  };

  const drawShape = (target: CanvasRenderingContext2D, shape: Shape) => {
    if (shape.tool === "mosaic") drawMosaic(target, shape);
    else drawAnnotation(target, shape);
  };
  const layers = createAnnotationLayers({
    getSize: () => ({ width: sourceCanvas.width, height: sourceCanvas.height }),
    drawShape,
    drawMosaicSegment: mosaic.drawSegment,
  });

  const drawSelectionMask = (region: Rect, selection: Rect | null) => {
    if (!selection || selection.w <= 0 || selection.h <= 0) return;
    context.fillStyle = "rgba(0,0,0,0.5)";
    context.fillRect(region.x, region.y, region.w, region.h);
    context.save();
    context.beginPath();
    context.rect(selection.x, selection.y, selection.w, selection.h);
    context.clip();
    context.drawImage(
      sourceCanvas,
      region.x,
      region.y,
      region.w,
      region.h,
      region.x,
      region.y,
      region.w,
      region.h,
    );
    context.restore();
  };

  const drawSelectedHandles = (shape: Shape) => {
    const box = shapeBBox(shape);
    context.strokeStyle = "#0096ff";
    context.lineWidth = 1.5;
    context.strokeRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4);
    for (const handle of shapeHandles(shape)) {
      context.fillStyle = "#fff";
      context.strokeStyle = "#3c3c3c";
      context.lineWidth = 1;
      const size = 10 * getScale();
      context.fillRect(handle.x - size / 2, handle.y - size / 2, size, size);
      context.strokeRect(handle.x - size / 2, handle.y - size / 2, size, size);
    }
  };

  const render = ({
    canvas,
    selection,
    shapes,
    currentShape,
    selectedIndex,
    magnifierPoint,
    windowHover,
  }: EditorRenderFrame) => {
    ensureSource();
    const damage = layers.update(shapes, currentShape);
    const frame = [
      canvas.width,
      canvas.height,
      selection?.x,
      selection?.y,
      selection?.w,
      selection?.h,
      selectedIndex,
      getScale(),
      windowHover?.x,
      windowHover?.y,
      windowHover?.w,
      windowHover?.h,
      magnifierPoint?.x,
      magnifierPoint?.y,
    ];
    const sameFrame =
      frame.length === previousFrame.length &&
      frame.every((value, index) => value === previousFrame[index]);
    previousFrame = frame;
    if (sameFrame && damage === null && !magnifierPoint) return;
    const full = !sameFrame || damage === "full" || !!magnifierPoint;
    const area = !full && damage ? damage : { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const x = Math.max(0, area.x),
      y = Math.max(0, area.y);
    const right = Math.min(canvas.width, area.x + area.w);
    const bottom = Math.min(canvas.height, area.y + area.h);
    const region = { x, y, w: right - x, h: bottom - y };
    if (region.w <= 0 || region.h <= 0) return;
    context.save();
    context.beginPath();
    context.rect(region.x, region.y, region.w, region.h);
    context.clip();
    context.clearRect(region.x, region.y, region.w, region.h);
    context.drawImage(
      sourceCanvas,
      region.x,
      region.y,
      region.w,
      region.h,
      region.x,
      region.y,
      region.w,
      region.h,
    );
    drawSelectionMask(region, selection);
    context.save();
    if (selection) {
      context.beginPath();
      context.rect(selection.x, selection.y, selection.w, selection.h);
      context.clip();
    }
    layers.paint(context, region);
    context.restore();
    if (selection && selection.w > 0 && selection.h > 0) {
      drawSelectionFrame(context, selection, getScale());
    }
    if (selectedIndex !== null && shapes[selectedIndex]) drawSelectedHandles(shapes[selectedIndex]);
    if (magnifierPoint) drawMagnifier(context, magnifierPoint.x, magnifierPoint.y);
    if (windowHover) drawSelectionFrame(context, windowHover, getScale());
    context.restore();
  };

  return {
    drawShape,
    render,
    reset: () => {
      sourceReady = false;
      sourceScreens = [];
      previousFrame = [];
      sourceCanvas.width = sourceCanvas.height = 0;
      mosaic.reset();
      layers.reset();
    },
  };
}

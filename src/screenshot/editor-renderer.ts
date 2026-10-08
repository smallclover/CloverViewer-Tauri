import { createCanvasMosaicRenderer } from "../image-editor/canvas-mosaic-renderer";
import { createAnnotationLayers } from "./annotation-layers";
import { drawAnnotation } from "./annotation-renderer";
import { type Shape, shapeBBox, shapeHandles } from "./geometry";
import { drawScreenBase, type ScreenImage } from "./screen-compositor";

export interface EditorRenderFrame {
  canvas: HTMLCanvasElement;
  shapes: readonly Shape[];
  currentShape: Shape | null;
  selectedIndex: number | null;
}

interface EditorCanvasRendererOptions {
  context: CanvasRenderingContext2D;
  getScreens: () => readonly ScreenImage[];
  getScale: () => number;
  mosaicWidth: number;
}

/** 只负责绘制编辑器画布；所有 DOM 布局与状态切换都留在这个模块之外。 */
export function createEditorCanvasRenderer({
  context,
  getScreens,
  getScale,
  mosaicWidth,
}: EditorCanvasRendererOptions) {
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.className = "screenshot-background";
  sourceCanvas.hidden = true;
  const sourceContext = sourceCanvas.getContext("2d", { alpha: false });
  if (!sourceContext) throw new Error("Canvas 2D context is unavailable");
  const mosaic = createCanvasMosaicRenderer(sourceCanvas);
  let sourceScreens: ScreenImage[] = [];
  let sourceReady = false;
  let previousFrame: unknown[] = [];
  let visible = false;
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

  const render = ({ canvas, shapes, currentShape, selectedIndex }: EditorRenderFrame) => {
    ensureSource();
    const damage = layers.update(shapes, currentShape);
    const frame = [canvas.width, canvas.height, selectedIndex, getScale()];
    const sameFrame =
      frame.length === previousFrame.length &&
      frame.every((value, index) => value === previousFrame[index]);
    previousFrame = frame;
    if (sameFrame && damage === null) return;
    const full = !sameFrame || damage === "full";
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
    layers.paint(context, region);
    if (selectedIndex !== null && shapes[selectedIndex]) drawSelectedHandles(shapes[selectedIndex]);
    context.restore();
  };

  return {
    background: sourceCanvas,
    setVisible: (next: boolean) => {
      if (visible !== next) previousFrame = [];
      visible = next;
      sourceCanvas.hidden = !next;
    },
    drawShape,
    render,
    reset: () => {
      sourceReady = false;
      sourceCanvas.hidden = true;
      visible = false;
      sourceScreens = [];
      previousFrame = [];
      sourceCanvas.width = sourceCanvas.height = 0;
      mosaic.reset();
      layers.reset();
    },
  };
}

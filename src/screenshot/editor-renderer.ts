import { drawAnnotation } from "./annotation-renderer";
import { type Pt, type Rect, shapeBBox, shapeHandles, type Shape } from "./geometry";
import { forEachMosaicStamp } from "./mosaic";
import { blitScreenRegion, drawScreenBase, type ScreenImage } from "./screen-compositor";
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

/** Renders only the editor canvas; all DOM layout and state transitions stay outside this module. */
export function createEditorCanvasRenderer({
  context,
  getScreens,
  getScale,
  mosaicWidth,
  drawMagnifier,
}: EditorCanvasRendererOptions) {
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 1;
  sampleCanvas.height = 1;
  const sampleContext = sampleCanvas.getContext("2d");
  if (!sampleContext) throw new Error("Canvas 2D context is unavailable");

  const drawMosaic = (target: CanvasRenderingContext2D, shape: Shape) => {
    const points = shape.points;
    if (!points?.length) return;
    const blockSize = Math.max(1, Math.round((shape.strokeWidth || mosaicWidth) * getScale()));
    const paintDot = (x: number, y: number) => {
      const sourceX = x - blockSize / 2;
      const sourceY = y - blockSize / 2;
      blitScreenRegion(
        sampleContext,
        getScreens(),
        sourceX,
        sourceY,
        blockSize,
        blockSize,
        0,
        0,
        1,
        1,
      );
      const pixel = sampleContext.getImageData(0, 0, 1, 1).data;
      target.fillStyle = `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${(pixel[3] / 255).toFixed(3)})`;
      target.fillRect(sourceX, sourceY, blockSize, blockSize);
    };
    forEachMosaicStamp(points, blockSize, (point) => paintDot(point.x, point.y));
  };

  const drawShape = (target: CanvasRenderingContext2D, shape: Shape) => {
    if (shape.tool === "mosaic") drawMosaic(target, shape);
    else drawAnnotation(target, shape, getScale());
  };

  const drawSelectionMask = (canvas: HTMLCanvasElement, selection: Rect | null) => {
    if (!selection || selection.w <= 0 || selection.h <= 0) return;
    context.fillStyle = "rgba(0,0,0,0.5)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.beginPath();
    context.rect(selection.x, selection.y, selection.w, selection.h);
    context.clip();
    drawScreenBase(context, getScreens());
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
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawScreenBase(context, getScreens());
    drawSelectionMask(canvas, selection);
    for (const shape of shapes) drawShape(context, shape);
    if (currentShape) drawShape(context, currentShape);
    if (selection && selection.w > 0 && selection.h > 0) {
      drawSelectionFrame(context, selection, getScale());
    }
    if (selectedIndex !== null && shapes[selectedIndex]) drawSelectedHandles(shapes[selectedIndex]);
    if (magnifierPoint) drawMagnifier(context, magnifierPoint.x, magnifierPoint.y);
    if (windowHover) drawSelectionFrame(context, windowHover, getScale());
  };

  return { drawShape, render };
}

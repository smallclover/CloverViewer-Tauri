import type { Pt, Shape } from "./geometry";
import { forEachMosaicStamp } from "./mosaic";

export function mosaicBlockSize(shape: Shape) {
  return shape.blockSize ?? Math.max(8, shape.strokeWidth * 3);
}

/** 从未被改动的源画布取样，保证预览与导出的马赛克像素完全一致。 */
export function createCanvasMosaicRenderer(sourceCanvas: HTMLCanvasElement) {
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 1;
  sampleCanvas.height = 1;
  const sampleContext = sampleCanvas.getContext("2d");
  if (!sampleContext) throw new Error("Canvas 2D is unavailable");

  const drawStamp = (target: CanvasRenderingContext2D, point: Pt, blockSize: number) => {
    const x = Math.max(
      0,
      Math.min(Math.max(0, sourceCanvas.width - blockSize), Math.round(point.x - blockSize / 2)),
    );
    const y = Math.max(
      0,
      Math.min(Math.max(0, sourceCanvas.height - blockSize), Math.round(point.y - blockSize / 2)),
    );
    sampleContext.clearRect(0, 0, 1, 1);
    sampleContext.drawImage(sourceCanvas, x, y, blockSize, blockSize, 0, 0, 1, 1);
    // 缩放这个单像素采样可避开 getImageData()，后者会同步 Canvas 管线，
    // 导致大图上的编辑画笔跟不上手速。
    target.drawImage(sampleCanvas, 0, 0, 1, 1, x, y, blockSize, blockSize);
  };

  const drawPoints = (target: CanvasRenderingContext2D, points: readonly Pt[], blockSize: number) =>
    forEachMosaicStamp(points, blockSize, (point) => drawStamp(target, point, blockSize));

  return {
    drawShape(target: CanvasRenderingContext2D, shape: Shape) {
      if (shape.points?.length) drawPoints(target, shape.points, mosaicBlockSize(shape));
    },
    drawSegment(target: CanvasRenderingContext2D, start: Pt, end: Pt, blockSize: number) {
      drawPoints(target, [start, end], blockSize);
    },
  };
}

import type { Pt, Shape } from "./geometry";

export function mosaicBlockSize(shape: Shape) {
  return shape.blockSize ?? Math.max(8, shape.strokeWidth * 3);
}

/** 原图只缩采样一次；圆形笔刷沿连续路径揭示同一份像素化图像。 */
export function createCanvasMosaicRenderer(sourceCanvas: HTMLCanvasElement) {
  let texture: HTMLCanvasElement | null = null;
  let textureSize = 0;
  const reset = () => {
    if (texture) texture.width = texture.height = 0;
    texture = null;
    textureSize = 0;
  };
  const textureFor = (size: number) => {
    if (texture && textureSize === size) return texture;
    reset();
    const grid = document.createElement("canvas");
    grid.width = Math.ceil(sourceCanvas.width / size);
    grid.height = Math.ceil(sourceCanvas.height / size);
    const sample = grid.getContext("2d");
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const context = canvas.getContext("2d");
    if (!sample || !context) throw new Error("Canvas 2D is unavailable");
    sample.imageSmoothingEnabled = true;
    sample.imageSmoothingQuality = "high";
    sample.drawImage(sourceCanvas, 0, 0, sourceCanvas.width / size, sourceCanvas.height / size);
    // 最后一行/列可能不足一整格，单独覆盖为完整采样像素，避免边缘变成半透明。
    const edgeWidth = sourceCanvas.width % size;
    const edgeHeight = sourceCanvas.height % size;
    const edge = (
      x: number,
      y: number,
      w: number,
      h: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => {
      sample.clearRect(dx, dy, dw, dh);
      sample.drawImage(sourceCanvas, x, y, w, h, dx, dy, dw, dh);
    };
    if (edgeWidth)
      edge(
        sourceCanvas.width - edgeWidth,
        0,
        edgeWidth,
        sourceCanvas.height,
        grid.width - 1,
        0,
        1,
        sourceCanvas.height / size,
      );
    if (edgeHeight)
      edge(
        0,
        sourceCanvas.height - edgeHeight,
        sourceCanvas.width,
        edgeHeight,
        0,
        grid.height - 1,
        sourceCanvas.width / size,
        1,
      );
    if (edgeWidth && edgeHeight)
      edge(
        sourceCanvas.width - edgeWidth,
        sourceCanvas.height - edgeHeight,
        edgeWidth,
        edgeHeight,
        grid.width - 1,
        grid.height - 1,
        1,
        1,
      );
    context.imageSmoothingEnabled = false;
    context.drawImage(grid, 0, 0, grid.width * size, grid.height * size);
    grid.width = grid.height = 0;
    texture = canvas;
    textureSize = size;
    return canvas;
  };

  const drawPoints = (target: CanvasRenderingContext2D, input: readonly Pt[], size: number) => {
    if (!Number.isFinite(size) || size <= 0 || !sourceCanvas.width || !sourceCanvas.height) return;
    const points = input.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!points.length) return;
    const radius = size / 2;
    let left = sourceCanvas.width;
    let top = sourceCanvas.height;
    let right = 0;
    let bottom = 0;
    for (const point of points) {
      left = Math.min(left, Math.floor(point.x - radius - 1));
      top = Math.min(top, Math.floor(point.y - radius - 1));
      right = Math.max(right, Math.ceil(point.x + radius + 1));
      bottom = Math.max(bottom, Math.ceil(point.y + radius + 1));
    }
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(sourceCanvas.width, right);
    bottom = Math.min(sourceCanvas.height, bottom);
    if (left >= right || top >= bottom) return;
    const pixels = textureFor(size);
    target.save();
    target.beginPath();
    for (let index = 0; index < points.length; index++) {
      const end = points[index];
      const start = points[Math.max(0, index - 1)];
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      // 每段是两端半圆的胶囊形；非零填充规则把所有段合成无间隙的圆头笔画。
      target.moveTo(
        start.x + Math.cos(angle - Math.PI / 2) * radius,
        start.y + Math.sin(angle - Math.PI / 2) * radius,
      );
      target.arc(end.x, end.y, radius, angle - Math.PI / 2, angle + Math.PI / 2);
      target.arc(start.x, start.y, radius, angle + Math.PI / 2, angle + Math.PI * 1.5);
      target.closePath();
    }
    target.clip();
    target.imageSmoothingEnabled = false;
    target.drawImage(
      pixels,
      left,
      top,
      right - left,
      bottom - top,
      left,
      top,
      right - left,
      bottom - top,
    );
    target.restore();
  };

  return {
    reset,
    drawShape(target: CanvasRenderingContext2D, shape: Shape) {
      const points = shape.points ?? [];
      const size = mosaicBlockSize(shape);
      // 与拖动预览使用完全相同的分段和叠加顺序，避免松开时抗锯齿边缘跳变。
      for (let index = 0; index < points.length; index++) {
        drawPoints(target, [points[Math.max(0, index - 1)], points[index]], size);
      }
    },
    drawSegment(target: CanvasRenderingContext2D, start: Pt, end: Pt, blockSize: number) {
      drawPoints(target, [start, end], blockSize);
    },
  };
}

import { blitScreenRegion, type ScreenImage } from "./screen-compositor";

const GRID_SIZE = 15;
const PIXEL_SIZE = 10;
const OFFSET = 20;
const INFO_HEIGHT = 64;

/** Convert the center pixel in a square RGBA sample into the copied color value. */
export function centerColorHex(data: Uint8ClampedArray, gridSize = GRID_SIZE): string {
  const half = Math.floor(gridSize / 2);
  const offset = (half * gridSize + half) * 4;
  return `#${[data[offset], data[offset + 1], data[offset + 2]]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

interface MagnifierOptions {
  getScreens: () => readonly ScreenImage[];
  getViewport: () => { width: number; height: number };
  getScale: () => number;
  translate: (key: string, vars?: Record<string, string | number>) => string;
  getCopyColorHotkey: () => string;
  getCopiedAt: () => number;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const clampedRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + clampedRadius, y);
  context.arcTo(x + width, y, x + width, y + height, clampedRadius);
  context.arcTo(x + width, y + height, x, y + height, clampedRadius);
  context.arcTo(x, y + height, x, y, clampedRadius);
  context.arcTo(x, y, x + width, y, clampedRadius);
  context.closePath();
}

/** Keeps the reusable sample canvas close to the magnifier renderer instead of editor state. */
export function createMagnifierRenderer({
  getScreens,
  getViewport,
  getScale,
  translate,
  getCopyColorHotkey,
  getCopiedAt,
}: MagnifierOptions) {
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = GRID_SIZE;
  sampleCanvas.height = GRID_SIZE;
  const sampleContext = sampleCanvas.getContext("2d");
  if (!sampleContext) throw new Error("Canvas 2D context is unavailable");
  let warnedZeroSample = false;

  const sample = (centerX: number, centerY: number): Uint8ClampedArray | null => {
    const half = Math.floor(GRID_SIZE / 2);
    const sourceX = Math.round(centerX) - half;
    const sourceY = Math.round(centerY) - half;
    sampleContext.clearRect(0, 0, GRID_SIZE, GRID_SIZE);
    blitScreenRegion(
      sampleContext,
      getScreens(),
      sourceX,
      sourceY,
      GRID_SIZE,
      GRID_SIZE,
      0,
      0,
      GRID_SIZE,
      GRID_SIZE,
    );
    let data: Uint8ClampedArray;
    try {
      data = sampleContext.getImageData(0, 0, GRID_SIZE, GRID_SIZE).data;
    } catch {
      return null;
    }
    if (!warnedZeroSample && data.every((value, index) => index % 4 !== 3 || value === 0)) {
      warnedZeroSample = true;
      console.warn("[screenshot] magnifier sampled only transparent pixels", { sourceX, sourceY });
    }
    return data;
  };

  const colorAt = (pointerX: number, pointerY: number): string | null => {
    const data = sample(pointerX, pointerY);
    if (!data) return null;
    return centerColorHex(data);
  };

  const draw = (context: CanvasRenderingContext2D, pointerX: number, pointerY: number) => {
    const data = sample(pointerX, pointerY);
    if (!data) return;

    const half = Math.floor(GRID_SIZE / 2);
    const gridLogicalSize = GRID_SIZE * PIXEL_SIZE;
    const viewport = getViewport();
    const scale = getScale();
    const cssScale = viewport.width / Math.max(viewport.width * scale, 1);
    const pointerCssX = pointerX / scale;
    const pointerCssY = pointerY / scale;

    let cardCssX = pointerCssX + OFFSET;
    let cardCssY = pointerCssY + OFFSET;
    const cardCssWidth = gridLogicalSize;
    const cardCssHeight = gridLogicalSize + INFO_HEIGHT;
    if (cardCssX + cardCssWidth > viewport.width) cardCssX = pointerCssX - OFFSET - cardCssWidth;
    if (cardCssY + cardCssHeight > viewport.height) cardCssY = pointerCssY - OFFSET - cardCssHeight;

    const physical = (value: number) => value / cssScale;
    context.save();
    context.setLineDash([]);
    context.fillStyle = "#ffffff";
    roundRect(
      context,
      physical(cardCssX),
      physical(cardCssY),
      physical(cardCssWidth),
      physical(cardCssHeight),
      4 * scale,
    );
    context.fill();

    const blockSize = physical(PIXEL_SIZE);
    for (let gridY = 0; gridY < GRID_SIZE; gridY += 1) {
      for (let gridX = 0; gridX < GRID_SIZE; gridX += 1) {
        const offset = (gridY * GRID_SIZE + gridX) * 4;
        context.fillStyle = `rgb(${data[offset]},${data[offset + 1]},${data[offset + 2]})`;
        context.fillRect(
          physical(cardCssX) + gridX * blockSize,
          physical(cardCssY) + gridY * blockSize,
          blockSize,
          blockSize,
        );
      }
    }

    context.strokeStyle = "rgba(0,0,0,0.31)";
    context.lineWidth = 1;
    context.beginPath();
    for (let index = 1; index < GRID_SIZE; index += 1) {
      const vertical = physical(cardCssX) + index * blockSize;
      context.moveTo(vertical, physical(cardCssY));
      context.lineTo(vertical, physical(cardCssY) + physical(gridLogicalSize));
      const horizontal = physical(cardCssY) + index * blockSize;
      context.moveTo(physical(cardCssX), horizontal);
      context.lineTo(physical(cardCssX) + physical(gridLogicalSize), horizontal);
    }
    context.stroke();

    const centerX = physical(cardCssX) + half * blockSize;
    const centerY = physical(cardCssY) + half * blockSize;
    context.strokeStyle = "#00ffff";
    context.lineWidth = 1.5 * scale;
    context.strokeRect(centerX, centerY, blockSize, blockSize);
    context.strokeStyle = "rgba(0,255,255,0.4)";
    context.lineWidth = 1;
    context.beginPath();
    const gridCenterX = physical(cardCssX) + physical(gridLogicalSize) / 2;
    const gridCenterY = physical(cardCssY) + physical(gridLogicalSize) / 2;
    context.moveTo(physical(cardCssX), gridCenterY);
    context.lineTo(physical(cardCssX) + physical(gridLogicalSize), gridCenterY);
    context.moveTo(gridCenterX, physical(cardCssY));
    context.lineTo(gridCenterX, physical(cardCssY) + physical(gridLogicalSize));
    context.stroke();

    const infoY = physical(cardCssY) + physical(gridLogicalSize);
    const infoHeight = physical(INFO_HEIGHT);
    context.strokeStyle = "#e6e6e6";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(physical(cardCssX), infoY);
    context.lineTo(physical(cardCssX) + physical(cardCssWidth), infoY);
    context.stroke();

    const color = centerColorHex(data);
    const rowHeight = infoHeight / 3;
    const padding = 8 * scale;
    context.textBaseline = "middle";
    context.fillStyle = "#282828";
    context.font = `${12 * scale}px "Segoe UI", sans-serif`;
    context.textAlign = "left";
    context.fillText(
      `(${Math.round(pointerX)}, ${Math.round(pointerY)})`,
      physical(cardCssX) + padding,
      infoY + rowHeight * 0.5 + 2 * scale,
    );
    const copiedRecently = performance.now() - getCopiedAt() < 1500;
    const colorText = copiedRecently ? translate("shot.copied") : color;
    context.fillStyle = copiedRecently ? "#28a03c" : "#282828";
    context.fillText(colorText, physical(cardCssX) + padding, infoY + rowHeight * 1.5 + 2 * scale);

    const textWidth = context.measureText(colorText).width;
    const previewSize = 12 * scale;
    const previewX = physical(cardCssX) + padding + textWidth + 8 * scale;
    const previewY = infoY + rowHeight * 1.5 + 2 * scale;
    context.fillStyle = color;
    roundRect(context, previewX, previewY - previewSize / 2, previewSize, previewSize, 2 * scale);
    context.fill();
    context.strokeStyle = "#c8c8c8";
    context.lineWidth = 1;
    context.strokeRect(previewX, previewY - previewSize / 2, previewSize, previewSize);

    context.fillStyle = "#969696";
    context.font = `${10 * scale}px "Segoe UI", sans-serif`;
    context.fillText(
      translate("shot.copyColorHint", { key: getCopyColorHotkey() }),
      physical(cardCssX) + padding,
      infoY + rowHeight * 2.5,
    );
    context.restore();
  };

  return { draw, colorAt };
}

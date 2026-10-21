import { blitScreenRegion, type ScreenImage } from "./screen-compositor";
import type { Rect } from "./geometry";

const GRID_SIZE = 15;
const PIXEL_SIZE = 8;
const OFFSET = 20;
const PADDING = 4;
const INFO_HEIGHT = 44;

/** 取正方形 RGBA 采样中中心像素的颜色值（复制用的十六进制色）。 */
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
  getTheme?: () => "light" | "dark";
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

/** 可复用的采样画布放在放大镜渲染器内部，而不是放进编辑器状态。 */
export function createMagnifierRenderer({
  getScreens,
  getViewport,
  getScale,
  translate,
  getCopyColorHotkey,
  getCopiedAt,
  getTheme = () => "dark",
}: MagnifierOptions) {
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = GRID_SIZE;
  sampleCanvas.height = GRID_SIZE;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) throw new Error("Canvas 2D context is unavailable");
  let warnedZeroSample = false;
  let sampledScreens: ScreenImage[] = [];
  let sampleX = Number.NaN,
    sampleY = Number.NaN;
  let cachedSample: Uint8ClampedArray | null = null;

  const sample = (centerX: number, centerY: number): Uint8ClampedArray | null => {
    const half = Math.floor(GRID_SIZE / 2);
    const sourceX = Math.round(centerX) - half;
    const sourceY = Math.round(centerY) - half;
    const screens = getScreens();
    if (
      cachedSample &&
      sourceX === sampleX &&
      sourceY === sampleY &&
      screens.length === sampledScreens.length &&
      screens.every((screen, index) => {
        const previous = sampledScreens[index];
        return (
          screen.image === previous.image &&
          screen.x === previous.x &&
          screen.y === previous.y &&
          screen.w === previous.w &&
          screen.h === previous.h
        );
      })
    )
      return cachedSample;
    if (sampleCanvas.width !== GRID_SIZE || sampleCanvas.height !== GRID_SIZE) {
      sampleCanvas.width = sampleCanvas.height = GRID_SIZE;
    }
    sampleContext.clearRect(0, 0, GRID_SIZE, GRID_SIZE);
    blitScreenRegion(
      sampleContext,
      screens,
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
      cachedSample = null;
      return null;
    }
    sampleX = sourceX;
    sampleY = sourceY;
    sampledScreens = screens.map((screen) => ({ ...screen }));
    cachedSample = data;
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

  const getBox = (pointerX: number, pointerY: number): Rect => {
    const gridLogicalSize = GRID_SIZE * PIXEL_SIZE;
    const viewport = getViewport();
    const scale = getScale();
    const pointerCssX = pointerX / scale;
    const pointerCssY = pointerY / scale;

    let cardCssX = pointerCssX + OFFSET;
    let cardCssY = pointerCssY + OFFSET;
    const cardCssWidth = gridLogicalSize + PADDING * 2;
    const cardCssHeight = gridLogicalSize + PADDING * 2 + INFO_HEIGHT;
    if (cardCssX + cardCssWidth > viewport.width) cardCssX = pointerCssX - OFFSET - cardCssWidth;
    if (cardCssY + cardCssHeight > viewport.height) cardCssY = pointerCssY - OFFSET - cardCssHeight;
    return {
      x: Math.max(0, Math.min(cardCssX, Math.max(0, viewport.width - cardCssWidth))),
      y: Math.max(0, Math.min(cardCssY, Math.max(0, viewport.height - cardCssHeight))),
      w: cardCssWidth,
      h: cardCssHeight,
    };
  };

  const draw = (context: CanvasRenderingContext2D, pointerX: number, pointerY: number) => {
    const data = sample(pointerX, pointerY);
    if (!data) return;
    const half = Math.floor(GRID_SIZE / 2);
    const gridLogicalSize = GRID_SIZE * PIXEL_SIZE;
    const scale = getScale();
    const {
      x: cardCssX,
      y: cardCssY,
      w: cardCssWidth,
      h: cardCssHeight,
    } = getBox(pointerX, pointerY);

    // 绘制仍用物理像素；卡片布局始终保持固定 CSS 尺寸。
    context.save();
    context.translate(cardCssX * scale, cardCssY * scale);
    context.scale(scale, scale);
    context.setLineDash([]);
    const light = getTheme() === "light";
    const foreground = light ? "#262b2a" : "#e5ebe6";
    const muted = light ? "#66756a" : "#a3b0a7";
    const accent = light ? "#3d8a49" : "#69b77a";
    const border = light ? "#cbd8ce" : "#46594c";
    context.fillStyle = light ? "#ffffff" : "#1c1e24";
    roundRect(context, 0.5, 0.5, cardCssWidth - 1, cardCssHeight - 1, 8);
    context.fill();
    context.strokeStyle = border;
    context.lineWidth = 1;
    context.stroke();

    const infoY = gridLogicalSize + PADDING * 2 - 1;
    context.save();
    context.clip();
    context.fillStyle = light ? "#f3f8f4" : "#212729";
    context.fillRect(1, infoY, cardCssWidth - 2, cardCssHeight - infoY - 1);
    context.restore();
    context.strokeStyle = light ? "#d3e1d6" : "#3e5144";
    context.beginPath();
    context.moveTo(1, infoY + 0.5);
    context.lineTo(cardCssWidth - 1, infoY + 0.5);
    context.stroke();

    context.save();
    roundRect(context, PADDING, PADDING, gridLogicalSize, gridLogicalSize, 4);
    context.clip();
    context.fillStyle = light ? "#f0f0f0" : "#14161c";
    context.fillRect(PADDING, PADDING, gridLogicalSize, gridLogicalSize);
    context.imageSmoothingEnabled = false;
    context.drawImage(
      sampleCanvas,
      0,
      0,
      GRID_SIZE,
      GRID_SIZE,
      PADDING,
      PADDING,
      gridLogicalSize,
      gridLogicalSize,
    );
    context.restore();

    // 黑白双层框适用于任意像素底色，不再用满铺网格和贯穿十字线。
    const center = PADDING + half * PIXEL_SIZE;
    context.strokeStyle = "#14161c";
    context.lineWidth = 3;
    context.strokeRect(center, center, PIXEL_SIZE, PIXEL_SIZE);
    context.strokeStyle = "#ffffff";
    context.lineWidth = 1;
    context.strokeRect(center, center, PIXEL_SIZE, PIXEL_SIZE);

    const infoX = 7;
    const infoWidth = cardCssWidth - infoX * 2;
    const colorY = infoY + 30;
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.font = '11px "Consolas", "Segoe UI", sans-serif';
    const text = (value: string, x: number, y: number, width = infoWidth) => {
      let fitted = value;
      while (fitted.length && context.measureText(fitted).width > width)
        fitted = fitted.slice(0, -1);
      if (fitted !== value) {
        while (fitted.length && context.measureText(`${fitted}…`).width > width)
          fitted = fitted.slice(0, -1);
        fitted += "…";
      }
      context.fillText(fitted, x, y);
    };
    const copiedRecently = performance.now() - getCopiedAt() < 1500;
    context.fillStyle = copiedRecently ? accent : muted;
    text(
      copiedRecently
        ? translate("shot.copied")
        : `${Math.round(pointerX)}, ${Math.round(pointerY)}`,
      infoX,
      infoY + 10,
    );

    const color = centerColorHex(data);
    context.fillStyle = color;
    roundRect(context, infoX, colorY - 5, 10, 10, 2);
    context.fill();
    context.strokeStyle = border;
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = foreground;
    text(color, infoX + 14, colorY, 52);

    // 键帽与色值并排；复制反馈使用整行，避免日语等较长文案挤占色值。
    context.font = '11px "Segoe UI", sans-serif';
    const hotkey = getCopyColorHotkey();
    const keyWidth = Math.max(34, Math.min(44, context.measureText(hotkey).width + 6));
    const keyX = cardCssWidth - infoX - keyWidth;
    context.fillStyle = light ? "#e4eee6" : "#34473a";
    roundRect(context, keyX, colorY - 9, keyWidth, 18, 4);
    context.fill();
    context.strokeStyle = light ? "#c5d8c9" : "#4b6654";
    context.stroke();
    context.fillStyle = accent;
    text(hotkey, keyX + 3, colorY, keyWidth - 6);
    context.restore();
  };

  return {
    draw,
    colorAt,
    getBox,
    reset: () => {
      sampledScreens = [];
      cachedSample = null;
      warnedZeroSample = false;
      sampleCanvas.width = sampleCanvas.height = 0;
    },
  };
}

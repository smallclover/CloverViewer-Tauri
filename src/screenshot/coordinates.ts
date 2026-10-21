import type { Pt, Rect } from "./geometry";

interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CaptureBounds {
  totalW: number;
  totalH: number;
}

/** 输入事件的视口坐标转为截图局部物理像素；与 DOM 矩形的横纵换算互为逆变换。 */
export function screenshotPoint(
  event: { clientX: number; clientY: number },
  viewport: Viewport,
  bounds: CaptureBounds,
): Pt {
  return {
    x: (event.clientX - viewport.left) * (bounds.totalW / viewport.width),
    y: (event.clientY - viewport.top) * (bounds.totalH / viewport.height),
  };
}

/** 所有源几何都是截图局部物理像素；DOM 布局使用 CSS 像素，不依赖单个显示器的 DPR。 */
export function createScreenshotCoordinates(options: {
  getViewport: () => Viewport;
  getBounds: () => CaptureBounds;
  getScreens: () => readonly Rect[];
}) {
  const toCssBox = (rect: Rect): Rect => {
    const viewport = options.getViewport();
    const { totalW, totalH } = options.getBounds();
    const kx = viewport.width / Math.max(totalW, 1);
    const ky = viewport.height / Math.max(totalH, 1);
    return { x: rect.x * kx, y: rect.y * ky, w: rect.w * kx, h: rect.h * ky };
  };
  const rootBox = (): Rect => {
    const viewport = options.getViewport();
    return { x: 0, y: 0, w: viewport.width, h: viewport.height };
  };
  return {
    toCssBox,
    rootBox,
    scale: () => {
      const { totalW } = options.getBounds();
      if (totalW <= 0) return 1;
      const width = options.getViewport().width;
      return width > 0 ? totalW / width : 1;
    },
    monitorBox: (anchor: Rect | null): Rect => {
      if (!anchor) return rootBox();
      const cx = anchor.x + anchor.w / 2;
      const cy = anchor.y + anchor.h / 2;
      const screen = options
        .getScreens()
        .find(
          (rect) => cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h,
        );
      // 显示器之间的空隙没有所属屏幕，此时才回退到整个截图窗口。
      return screen ? toCssBox(screen) : rootBox();
    },
  };
}

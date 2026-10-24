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
      const screens = options.getScreens();
      let screen = screens.find(
        (rect) => cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h,
      );
      // A cross-screen selection can have its center in a desktop gap. Keep its UI
      // on a real monitor: prefer the largest intersection, then the closest screen.
      if (!screen) {
        let bestArea = -1;
        let bestDistance = Infinity;
        for (const rect of screens) {
          const area =
            Math.max(
              0,
              Math.min(anchor.x + anchor.w, rect.x + rect.w) - Math.max(anchor.x, rect.x),
            ) *
            Math.max(
              0,
              Math.min(anchor.y + anchor.h, rect.y + rect.h) - Math.max(anchor.y, rect.y),
            );
          const dx = Math.max(rect.x - cx, 0, cx - rect.x - rect.w);
          const dy = Math.max(rect.y - cy, 0, cy - rect.y - rect.h);
          const distance = dx * dx + dy * dy;
          if (area > bestArea || (area === bestArea && distance < bestDistance)) {
            screen = rect;
            bestArea = area;
            bestDistance = distance;
          }
        }
      }
      return screen ? toCssBox(screen) : rootBox();
    },
  };
}

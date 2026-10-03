import { overlaps, placeScrollOverlay } from "./overlay-layout";
import type { Rect } from "./geometry";
import type { ScrollCaptureProgress } from "../api";

export interface CssBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ScrollCapturePositionerOptions {
  getSelection: () => Rect | null;
  getCaptureRect: () => Rect | null;
  toCssBox: (rect: Rect) => CssBox;
  rootBox: () => CssBox;
  monitorBox: (anchor: Rect | null) => CssBox;
  panel: HTMLElement;
  hud: HTMLElement;
  notice: HTMLElement;
  glow: HTMLElement;
  onHudOverlap: (overlapsCapture: boolean) => void;
}

/** 把截图控件摆到选区之外，并按 CSS 像素把提示居中。 */
export function createScrollCapturePositioner(options: ScrollCapturePositionerOptions) {
  const place = (element: HTMLElement, region: CssBox, monitor: CssBox) => {
    const point = placeScrollOverlay(region, monitor, {
      w: element.offsetWidth || 280,
      h: element.offsetHeight || 100,
    });
    element.style.left = `${point.x}px`;
    element.style.top = `${point.y}px`;
  };

  const positionNotice = () => {
    if (!options.notice.classList.contains("on")) return;
    const capture = options.getCaptureRect() ?? options.getSelection();
    const monitor = capture ? options.monitorBox(capture) : options.rootBox();
    const margin = 10;
    options.notice.style.maxWidth = `${Math.max(1, Math.min(420, monitor.w - margin * 2))}px`;
    options.notice.style.maxHeight = `${Math.max(1, monitor.h - margin * 2)}px`;
    options.notice.style.left = `${monitor.x + margin}px`;
    const width = options.notice.offsetWidth || 320;
    const height = options.notice.offsetHeight || 40;
    const region = capture ? options.toCssBox(capture) : null;
    const anchor =
      region && region.w >= width + margin * 2 && region.h >= height + margin * 2
        ? region
        : monitor;
    const minX = monitor.x + margin;
    const maxX = Math.max(minX, monitor.x + monitor.w - width - margin);
    const minY = monitor.y + margin;
    const maxY = Math.max(minY, monitor.y + monitor.h - height - margin);
    const x = Math.max(minX, Math.min(anchor.x + (anchor.w - width) / 2, maxX));
    const y = Math.max(minY, Math.min(anchor.y + (anchor.h - height) / 2, maxY));
    options.notice.style.left = `${x}px`;
    options.notice.style.top = `${y}px`;
  };

  const position = () => {
    const capture = options.getCaptureRect() ?? options.getSelection();
    if (!capture) return;
    const region = options.toCssBox(capture);
    const monitor = options.monitorBox(capture);
    if (options.glow.classList.contains("on")) {
      const gap = 50;
      options.glow.style.cssText = `left:${region.x - gap}px;top:${region.y - gap}px;width:${region.w + gap * 2}px;height:${region.h + gap * 2}px`;
    }
    if (options.panel.classList.contains("open")) place(options.panel, region, monitor);
    if (options.hud.classList.contains("open")) {
      place(options.hud, region, monitor);
      const width = options.hud.offsetWidth || 280;
      const height = options.hud.offsetHeight || 100;
      const x = Number.parseFloat(options.hud.style.left) || 0;
      const y = Number.parseFloat(options.hud.style.top) || 0;
      options.onHudOverlap(overlaps({ x, y, w: width, h: height }, region));
    }
    positionNotice();
  };

  return { position, positionNotice };
}

/** 按物理像素绘制截图时的遮罩与透明的截取孔。 */
export function renderScrollCaptureOverlay(options: {
  context: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  selection: Rect | null;
  captureRect: Rect | null;
  phase: "idle" | "armed" | "capturing" | "done";
  progress: ScrollCaptureProgress | null;
  error: string;
  scale: number;
}): void {
  const { context, canvas, selection, captureRect, phase, progress, error, scale } = options;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!selection) return;
  const capture = captureRect ?? selection;
  context.fillStyle = "rgba(0,0,0,0.45)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.clearRect(
    capture.x - scale,
    capture.y - scale,
    capture.w + scale * 2,
    capture.h + scale * 2,
  );
  if (phase === "capturing") return;
  context.strokeStyle =
    progress?.stage === "low_confidence" ? "#ffb300" : error ? "#ff5252" : "#00ff00";
  context.lineWidth = scale;
  context.strokeRect(
    selection.x - scale / 2,
    selection.y - scale / 2,
    selection.w + scale,
    selection.h + scale,
  );
}

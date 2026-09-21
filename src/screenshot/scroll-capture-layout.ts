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

/** Positions every scroll-capture overlay in CSS pixels, outside the capture region where possible. */
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
    const width = options.notice.offsetWidth || 320;
    const height = options.notice.offsetHeight || 40;
    const minX = monitor.x + 10;
    const maxX = Math.max(minX, monitor.x + monitor.w - width - 10);
    const x = Math.max(minX, Math.min(monitor.x + (monitor.w - width) / 2, maxX));
    let y = monitor.y + monitor.h - height - 16;
    if (capture) {
      const region = options.toCssBox(capture);
      if (overlaps({ x, y, w: width, h: height }, region)) {
        const top = monitor.y + 16;
        if (!overlaps({ x, y: top, w: width, h: height }, region)) y = top;
      }
    }
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

/** Draws the capture-time dimmer and transparent capture hole in physical pixels. */
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

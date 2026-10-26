import type { BeautifyDocument } from "../api";
import type { BeautyLayout } from "./layout";
import { roundedPath } from "./frame-path";
import { beautyBackground, frameStyle } from "./model";
import { paintWindow } from "./window-frame";
import { paintMountedFrame } from "./mounted-frame";

export const isWindowFrame = (kind: string) => ["mac-light", "mac-dark", "browser"].includes(kind);
export const isMountedFrame = (kind: string) => ["gallery", "wood", "polaroid"].includes(kind);
export function contentRadius(document: BeautifyDocument, layout: BeautyLayout): number | number[] {
  if (!document.enabled || isMountedFrame(document.frame.kind)) return 0;
  const radius = document.frame.radius * layout.scale;
  if (isWindowFrame(document.frame.kind))
    return [
      0,
      0,
      Math.max(0, radius - document.frame.borderWidth * layout.scale),
      Math.max(0, radius - document.frame.borderWidth * layout.scale),
    ];
  return document.frame.kind !== "none" || beautyBackground(document).kind !== "transparent"
    ? radius
    : 0;
}

export function paintBackground(
  context: CanvasRenderingContext2D,
  document: BeautifyDocument,
  layout: BeautyLayout,
) {
  if (!document.enabled) return;
  const background = beautyBackground(document);
  if (background.kind === "transparent") return;
  if (background.kind === "gradient") {
    const angle = (background.angle * Math.PI) / 180;
    const dx = (Math.cos(angle) * layout.width) / 2,
      dy = (Math.sin(angle) * layout.height) / 2;
    const gradient = context.createLinearGradient(
      layout.width / 2 - dx,
      layout.height / 2 - dy,
      layout.width / 2 + dx,
      layout.height / 2 + dy,
    );
    gradient.addColorStop(0, background.color);
    gradient.addColorStop(1, background.endColor);
    context.fillStyle = gradient;
  } else context.fillStyle = background.color;
  context.fillRect(0, 0, layout.width, layout.height);
}

export function paintFrame(
  context: CanvasRenderingContext2D,
  document: BeautifyDocument,
  layout: BeautyLayout,
  time: Date,
  factor: number,
) {
  const frame = document.frame;
  if (!document.enabled || frame.kind === "none") return;
  const window = isWindowFrame(frame.kind),
    mounted = isMountedFrame(frame.kind),
    style = frameStyle(frame);
  const radius = mounted
    ? frame.kind === "polaroid"
      ? 2 * layout.detailScale
      : 0
    : frame.radius * layout.scale;
  const fill = window
    ? frame.kind === "mac-dark"
      ? "#30363b"
      : "#f4f6f8"
    : mounted
      ? style.matColor
      : beautyBackground(document).color;
  if (frame.kind !== "border" && frame.shadow > 0) {
    context.save();
    context.fillStyle = fill;
    context.shadowColor = window && frame.kind === "mac-dark" ? "#00000070" : "#14241a40";
    context.shadowBlur = frame.shadow * layout.scale * factor * (window ? 1.65 : 1.2);
    context.shadowOffsetY = frame.shadow * layout.scale * factor * 0.7;
    roundedPath(context, layout.shell, radius);
    context.fill();
    context.restore();
  }
  context.fillStyle = fill;
  roundedPath(context, layout.shell, radius);
  context.fill();
  if (window) paintWindow(context, frame, layout);
  if (mounted) paintMountedFrame(context, frame, layout, time);
}

export function paintFrameEdge(
  context: CanvasRenderingContext2D,
  document: BeautifyDocument,
  layout: BeautyLayout,
) {
  const frame = document.frame;
  if (
    !document.enabled ||
    frame.kind === "none" ||
    isMountedFrame(frame.kind) ||
    frame.borderWidth <= 0
  )
    return;
  const border = frame.borderWidth * layout.scale,
    window = isWindowFrame(frame.kind);
  const rect = window ? layout.shell : layout.content;
  const inset = window ? border / 2 : -border / 2;
  context.strokeStyle = frame.borderColor;
  context.lineWidth = border;
  roundedPath(
    context,
    {
      x: rect.x + inset,
      y: rect.y + inset,
      w: Math.max(0, rect.w - inset * 2),
      h: Math.max(0, rect.h - inset * 2),
    },
    Math.max(0, frame.radius * layout.scale - inset),
  );
  context.stroke();
  if (window) {
    context.save();
    roundedPath(context, layout.shell, frame.radius * layout.scale);
    context.clip();
    context.fillStyle = frame.kind === "mac-dark" ? "#ffffff16" : "#ffffffb3";
    context.fillRect(
      layout.shell.x + frame.radius * layout.scale,
      layout.shell.y + border,
      Math.max(0, layout.shell.w - frame.radius * layout.scale * 2),
      Math.max(0.5, layout.detailScale),
    );
    context.restore();
  }
}

import type { BeautifyFrame } from "../api";
import type { BeautyLayout } from "./layout";
import { fittedText, roundedPath } from "./frame-path";
import { frameStyle } from "./model";

export function paintWindow(
  context: CanvasRenderingContext2D,
  frame: BeautifyFrame,
  layout: BeautyLayout,
) {
  const { shell, content, scale } = layout,
    style = frameStyle(frame);
  const dark = frame.kind === "mac-dark",
    browser = frame.kind === "browser";
  const border = frame.borderWidth * scale;
  const bar = {
    x: shell.x + border,
    y: shell.y + border,
    w: shell.w - border * 2,
    h: content.y - shell.y - border,
  };
  if (bar.w <= 0 || bar.h <= 0) return;
  const gradient = context.createLinearGradient(0, bar.y, 0, bar.y + bar.h);
  gradient.addColorStop(0, dark ? "#3c4248" : "#fafbfc");
  gradient.addColorStop(1, dark ? "#2a3036" : "#e9ecef");
  context.save();
  roundedPath(context, shell, frame.radius * scale);
  context.clip();
  context.fillStyle = gradient;
  context.fillRect(bar.x, bar.y, bar.w, bar.h);
  context.fillStyle = dark ? "#00000066" : "#2538321c";
  context.fillRect(
    bar.x,
    bar.y + bar.h - Math.max(0.5, layout.detailScale),
    bar.w,
    Math.max(0.5, layout.detailScale),
  );
  const radius = bar.h * 0.12,
    gap = radius * 3.3,
    left = bar.x + bar.h * 0.47,
    cy = bar.y + bar.h / 2;
  ["#ff6058", "#ffbd2e", "#28c840"].forEach((color, i) => {
    context.beginPath();
    context.arc(left + i * gap, cy, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.strokeStyle = "#00000018";
    context.lineWidth = Math.max(0.4, layout.detailScale * 0.7);
    context.stroke();
  });
  context.textBaseline = "middle";
  const lightsEnd = left + gap * 2 + radius + bar.h * 0.5;
  if (browser && !style.compact) {
    const field = {
      x: lightsEnd,
      y: bar.y + bar.h * 0.2,
      w: Math.max(0, Math.min(bar.w * 0.69, shell.x + shell.w - bar.h * 0.4 - lightsEnd)),
      h: bar.h * 0.6,
    };
    if (field.w > 0) {
      roundedPath(context, field, 8 * layout.detailScale);
      context.fillStyle = "#ffffffc9";
      context.fill();
      context.strokeStyle = "#aeb8c04d";
      context.lineWidth = Math.max(0.5, layout.detailScale);
      context.stroke();
      context.fillStyle = "#72808b";
      context.textAlign = "center";
      context.font = `${bar.h * 0.32}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      context.fillText(
        fittedText(context, style.url, field.w - bar.h * 0.4),
        field.x + field.w / 2,
        cy,
      );
    }
  } else if (!style.compact && style.title) {
    context.fillStyle = dark ? "#c8d0d5" : "#68757b";
    context.textAlign = "center";
    context.font = `${bar.h * 0.38}px "Segoe UI", "Yu Gothic", "Microsoft YaHei", sans-serif`;
    const width = Math.max(0, shell.w - (lightsEnd - shell.x) * 2);
    context.fillText(fittedText(context, style.title, width), shell.x + shell.w / 2, cy);
  }
  context.restore();
}

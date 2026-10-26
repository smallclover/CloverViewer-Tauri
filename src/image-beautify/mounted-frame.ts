import type { BeautifyFrame } from "../api";
import type { BeautyLayout } from "./layout";
import { fittedText } from "./frame-path";
import { paintPaper, paintWood } from "./materials";
import { frameStyle, resolveWatermarkText } from "./model";

export function paintMountedFrame(
  context: CanvasRenderingContext2D,
  frame: BeautifyFrame,
  layout: BeautyLayout,
  time: Date,
) {
  const { shell, content, scale, detailScale: unit } = layout,
    style = frameStyle(frame);
  if (frame.kind === "polaroid") {
    paintPaper(context, shell, style.matColor, unit);
    const bottom = shell.y + shell.h - content.y - content.h;
    if (bottom <= 0) return;
    context.save();
    context.beginPath();
    context.rect(content.x, content.y + content.h, content.w, bottom);
    context.clip();
    const y = content.y + content.h + bottom * 0.57;
    const date = style.captionDate
      ? resolveWatermarkText("{date}", time).replaceAll("-", " · ")
      : "";
    context.fillStyle = style.accentColor;
    context.textBaseline = "middle";
    context.font = `${24 * unit}px "Segoe UI", sans-serif`;
    context.textAlign = "right";
    const dateWidth = Math.min(content.w * 0.45, context.measureText(date).width);
    context.fillText(fittedText(context, date, content.w * 0.45), content.x + content.w, y);
    context.font = `italic ${40 * unit}px Georgia, "Yu Mincho", "SimSun", serif`;
    context.textAlign = "left";
    context.fillText(
      fittedText(
        context,
        resolveWatermarkText(style.caption, time),
        Math.max(0, content.w - dateWidth - 20 * unit),
      ),
      content.x,
      y,
    );
    context.restore();
    return;
  }
  const rail = style.railWidth * scale;
  const mat = {
    x: shell.x + rail,
    y: shell.y + rail,
    w: shell.w - rail * 2,
    h: shell.h - rail * 2,
  };
  if (frame.kind === "wood") paintWood(context, shell, rail, frame.borderColor, unit);
  else {
    const gradient = context.createLinearGradient(
      shell.x,
      shell.y,
      shell.x + shell.w,
      shell.y + shell.h,
    );
    gradient.addColorStop(0, "#535951");
    gradient.addColorStop(0.15, frame.borderColor);
    gradient.addColorStop(0.85, frame.borderColor);
    gradient.addColorStop(1, "#111812");
    context.fillStyle = gradient;
    context.fillRect(shell.x, shell.y, shell.w, shell.h);
  }
  paintPaper(context, mat, style.matColor, unit);
  context.strokeStyle = "#00000025";
  context.lineWidth = Math.max(0.6, unit);
  context.strokeRect(mat.x, mat.y, mat.w, mat.h);
  const inner = style.innerWidth * scale;
  context.fillStyle = style.accentColor;
  context.fillRect(
    content.x - inner,
    content.y - inner,
    content.w + inner * 2,
    content.h + inner * 2,
  );
  // Beveled inner edge: shaded top/left, illuminated bottom/right, outside image pixels.
  const bevel = Math.max(0.5, Math.min(2.5 * unit, inner || unit));
  context.fillStyle = "#514a3d55";
  context.fillRect(content.x - bevel, content.y - bevel, content.w + bevel * 2, bevel);
  context.fillRect(content.x - bevel, content.y, bevel, content.h);
  context.fillStyle = "#fff9";
  context.fillRect(content.x, content.y + content.h, content.w + bevel, bevel);
  context.fillRect(content.x + content.w, content.y, bevel, content.h);
}

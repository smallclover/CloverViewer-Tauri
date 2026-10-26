import type { BeautifyDocument, BeautifyWatermark } from "../api";
import { beautyBackground, beautyScale, frameStyle } from "./model";

export interface BeautyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface BeautyLayout {
  width: number;
  height: number;
  scale: number;
  detailScale: number;
  content: BeautyRect;
  shell: BeautyRect;
  regions: Record<BeautifyWatermark["region"], BeautyRect>;
}

export function beautyLayout(
  width: number,
  height: number,
  document: BeautifyDocument,
): BeautyLayout {
  const scale = beautyScale(document, width, height);
  const frame = document.frame;
  if (
    ["mac-light", "mac-dark", "browser", "gallery", "wood", "polaroid", "none"].includes(frame.kind)
  )
    return styledLayout(width, height, document, scale);
  const active = document.enabled && frame.kind !== "none";
  const card =
    active && (frame.kind !== "border" || beautyBackground(document).kind !== "transparent");
  const border = active ? frame.borderWidth * scale : 0;
  const spread = card && frame.kind !== "border" ? frame.shadow * scale * 3 : 0;
  const pad = frame.padding.map((n) => (card ? Math.max(n * scale, spread) + border : border));
  const [top, right, bottom, left] = active ? pad : [0, 0, 0, 0];
  const w = Math.ceil(width + left + right),
    h = Math.ceil(height + top + bottom);
  const content = { x: left, y: top, w: width, h: height };
  return {
    width: w,
    height: h,
    scale,
    detailScale: Math.min(width, height) / 1000,
    content,
    shell: { ...content },
    regions: {
      content,
      top: { x: left, y: 0, w: width, h: top },
      bottom: { x: left, y: top + height, w: width, h: bottom },
      left: { x: 0, y: top, w: left, h: height },
      right: { x: left + width, y: top, w: right, h: height },
    },
  };
}

function styledLayout(
  width: number,
  height: number,
  document: BeautifyDocument,
  scale: number,
): BeautyLayout {
  const frame = document.frame,
    style = frameStyle(frame),
    active = document.enabled;
  const window = ["mac-light", "mac-dark", "browser"].includes(frame.kind);
  const mounted = frame.kind === "gallery" || frame.kind === "wood";
  const paper = frame.kind === "polaroid";
  const hasFrame = active && frame.kind !== "none";
  const padded = active && (hasFrame || beautyBackground(document).kind !== "transparent");
  const shadow = hasFrame ? frame.shadow * scale * 3 : 0;
  const [pt, pr, pb, pl] = frame.padding.map((n) =>
    padded ? Math.ceil(Math.max(n * scale, shadow)) : 0,
  );
  const border = hasFrame ? frame.borderWidth * scale : 0;
  const rail = mounted && active ? style.railWidth * scale : 0;
  const mat = (mounted || paper) && active ? style.matWidth * scale : 0;
  const inner = mounted && active ? style.innerWidth * scale : 0;
  // Align source pixels to whole output pixels so screenshot text stays crisp.
  const inset = Math.round(mounted ? rail + mat + inner : paper ? mat : border);
  const header =
    window && active ? Math.round(style.titleBarHeight * scale * (style.compact ? 0.65 : 1)) : 0;
  const bottom = paper && active ? Math.round(Math.max(style.paperBottom * scale, mat)) : inset;
  const shell = { x: pl, y: pt, w: width + inset * 2, h: height + inset + header + bottom };
  const content = { x: shell.x + inset, y: shell.y + inset + header, w: width, h: height };
  const outWidth = Math.ceil(shell.w + pl + pr),
    outHeight = Math.ceil(shell.h + pt + pb);
  const regions =
    mounted || paper
      ? {
          content,
          top: { x: shell.x + rail, y: shell.y + rail, w: shell.w - rail * 2, h: mat },
          bottom: {
            x: shell.x + rail,
            y: content.y + height + inner,
            w: shell.w - rail * 2,
            h: paper ? bottom : mat,
          },
          left: { x: shell.x + rail, y: content.y, w: mat, h: height },
          right: { x: content.x + width + inner, y: content.y, w: mat, h: height },
        }
      : {
          content,
          top: { x: shell.x, y: 0, w: shell.w, h: pt },
          bottom: { x: shell.x, y: shell.y + shell.h, w: shell.w, h: pb },
          left: { x: 0, y: shell.y, w: pl, h: shell.h },
          right: { x: shell.x + shell.w, y: shell.y, w: pr, h: shell.h },
        };
  return {
    width: outWidth,
    height: outHeight,
    scale,
    detailScale: Math.min(width, height) / 1000,
    shell,
    content,
    regions,
  };
}

export function watermarkPoint(
  region: BeautyRect,
  layer: BeautifyWatermark,
  scale: number,
  w: number,
  h: number,
) {
  const ax = (layer.anchor % 3) / 2,
    ay = Math.floor(layer.anchor / 3) / 2;
  return {
    x: region.x + w / 2 + (region.w - w) * ax + layer.x * scale,
    y: region.y + h / 2 + (region.h - h) * ay + layer.y * scale,
  };
}

export function rotatedSize(w: number, h: number, degrees: number) {
  const angle = (degrees * Math.PI) / 180;
  return {
    w: Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle)),
    h: Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle)),
  };
}

/** Budget covers content, output, encoder copies, and preview; reject before allocating. */
export function checkBeautySize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > 32767 ||
    height > 32767 ||
    width * height > 24_000_000
  )
    throw new Error("beautify.tooLarge");
}

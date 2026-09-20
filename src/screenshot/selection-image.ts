import type { Rect } from "./geometry";
import { blitScreenRegion, type ScreenImage } from "./screen-compositor";

async function toBase64(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("toBlob failed"))),
      "image/png",
    ),
  );
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Crop the captured desktop to the current selection, optionally compositing annotations. */
export async function selectionToPngBase64({
  selection,
  screens,
  drawAnnotations,
}: {
  selection: Rect;
  screens: readonly ScreenImage[];
  drawAnnotations?: (context: CanvasRenderingContext2D) => void;
}): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(selection.w);
  canvas.height = Math.round(selection.h);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  context.imageSmoothingEnabled = true;
  blitScreenRegion(
    context,
    screens,
    selection.x,
    selection.y,
    selection.w,
    selection.h,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  if (drawAnnotations) {
    context.save();
    context.translate(-selection.x, -selection.y);
    drawAnnotations(context);
    context.restore();
  }
  return toBase64(canvas);
}

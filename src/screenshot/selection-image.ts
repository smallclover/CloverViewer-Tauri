import type { Rect } from "./geometry";
import { blitScreenRegion, type ScreenImage } from "./screen-compositor";

export async function selectionCanvasToBase64(canvas: HTMLCanvasElement): Promise<string> {
  try {
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("toBlob failed"))),
        "image/png",
      ),
    );
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/** 按当前选区裁剪截取到的桌面，并可选择叠加标注。 */
export function selectionToCanvas({
  selection,
  screens,
  drawAnnotations,
}: {
  selection: Rect;
  screens: readonly ScreenImage[];
  drawAnnotations?: (context: CanvasRenderingContext2D) => void;
}): HTMLCanvasElement {
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
  return canvas;
}

export async function selectionToPngBase64(
  options: Parameters<typeof selectionToCanvas>[0],
): Promise<string> {
  return selectionCanvasToBase64(selectionToCanvas(options));
}

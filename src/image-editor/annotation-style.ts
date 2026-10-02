import type { Shape } from "./geometry";

export type SizeKind = "strokeWidth" | "fontSize" | "blockSize";

/** All annotation sizes are physical pixels in the original image. */
export const SIZE_PRESETS: Record<SizeKind, readonly number[]> = {
  strokeWidth: [1, 2, 3, 4, 6, 8, 12],
  fontSize: [12, 16, 20, 24, 32, 48, 64, 72],
  blockSize: [8, 12, 16, 24, 32, 48],
};
export const SIZE_LABELS: Record<SizeKind, string> = {
  strokeWidth: "shot.width",
  fontSize: "editor.fontSize",
  blockSize: "editor.blockSize",
};
export function sizeKind(tool: string | null): SizeKind {
  return tool === "text" ? "fontSize" : tool === "mosaic" ? "blockSize" : "strokeWidth";
}
export function createAnnotationSizes() {
  return { strokeWidth: 2, fontSize: 24, blockSize: 16 };
}

// Older in-memory shapes did not have an explicit font size.
export function textFontSize(shape: Pick<Shape, "fontSize" | "strokeWidth">) {
  return shape.fontSize ?? 20 + shape.strokeWidth * 2;
}
export function annotationFont(size: number) {
  return `600 ${size}px "Segoe UI", system-ui, sans-serif`;
}

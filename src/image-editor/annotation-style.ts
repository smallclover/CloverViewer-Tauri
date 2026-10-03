import type { Shape } from "./geometry";

export type SizeKind = "strokeWidth" | "fontSize" | "blockSize";

/** 所有标注尺寸都是原图像的物理像素。 */
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

/** 按预览缩放初始化一次图片编辑器的尺寸档位，存储值仍以原图像素为准。 */
export function createPreviewAnnotationSizing(previewScale: number) {
  const scale = Number.isFinite(previewScale) && previewScale > 0 ? Math.min(1, previewScale) : 1;
  const toImagePixels = (size: number) => Math.max(1, Math.round(size / scale));
  const sizes = createAnnotationSizes();
  const presets = { ...SIZE_PRESETS };
  for (const kind of Object.keys(sizes) as SizeKind[]) {
    sizes[kind] = toImagePixels(sizes[kind]);
    presets[kind] = SIZE_PRESETS[kind].map(toImagePixels);
  }
  return { sizes, presets };
}

// fontSize 为可选字段，缺省时按 strokeWidth 推导。
export function textFontSize(shape: Pick<Shape, "fontSize" | "strokeWidth">) {
  return shape.fontSize ?? 20 + shape.strokeWidth * 2;
}
export function annotationFont(size: number) {
  return `600 ${size}px "Segoe UI", system-ui, sans-serif`;
}

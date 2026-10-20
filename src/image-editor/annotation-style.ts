import type { Shape } from "./geometry";

export type SizeKind = "strokeWidth" | "fontSize" | "blockSize";

/** 截图使用原图像素；图片编辑工具栏使用屏幕像素，绘制时换算。 */
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

/** 每次开始标注时按当前预览比例换算，保留小数以支持放大绘制细线。 */
export function imageAnnotationSizes(sizes: Record<SizeKind, number>, previewScale: number) {
  const scale = Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1;
  return {
    strokeWidth: sizes.strokeWidth / scale,
    fontSize: sizes.fontSize / scale,
    blockSize: sizes.blockSize / scale,
    arrowHeadSize: (12 + sizes.strokeWidth * 2) / scale,
  };
}

// fontSize 为可选字段，缺省时按 strokeWidth 推导。
export function textFontSize(shape: Pick<Shape, "fontSize" | "strokeWidth">) {
  return shape.fontSize ?? 20 + shape.strokeWidth * 2;
}
export function annotationFont(size: number) {
  return `600 ${size}px "Segoe UI", system-ui, sans-serif`;
}

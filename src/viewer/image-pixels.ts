import { canvasPng } from "../image-editor/canvas-export";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp", "gif", "webp", "tif", "tiff", "avif"];
export const requiresBrowserPixels = (path: string) => /\.avif$/i.test(path);

/** AVIF 使用 WebView 已有的解码能力，把同源像素交给原生复制和分享。 */
export function createImagePixelExporter(readSource: (path: string) => Promise<string>) {
  return async (path: string, maxEdge?: number) => {
    if (!requiresBrowserPixels(path)) return undefined;
    const image = new Image();
    image.src = await readSource(path);
    try {
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("Image has no pixels");
      const canvas = document.createElement("canvas");
      const scale =
        maxEdge && maxEdge > 0
          ? Math.min(1, maxEdge / image.naturalWidth, maxEdge / image.naturalHeight)
          : 1;
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D is unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return await canvasPng(canvas);
    } finally {
      image.removeAttribute("src");
    }
  };
}

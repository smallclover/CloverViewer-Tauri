/** Cache two viewport-sized bitmaps; dragging changes only the color preview's clip. */
export function createCropPreview(source: HTMLCanvasElement, root: HTMLElement) {
  const gray = document.createElement("canvas");
  const color = document.createElement("canvas");
  gray.className = "image-crop-preview image-crop-gray";
  color.className = "image-crop-preview image-crop-color";
  root.append(gray, color);
  const grayContext = gray.getContext("2d"),
    colorContext = color.getContext("2d");
  if (!grayContext || !colorContext) throw new Error("Canvas 2D is unavailable");
  let dirty = true;
  return {
    invalidate: () => {
      dirty = true;
    },
    prepare: (width: number, height: number) => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.ceil(width * ratio)),
        h = Math.max(1, Math.ceil(height * ratio));
      if (!dirty && color.width === w && color.height === h) return;
      color.width = gray.width = w;
      color.height = gray.height = h;
      colorContext.drawImage(source, 0, 0, w, h);
      grayContext.filter = "grayscale(1) brightness(0.72)";
      grayContext.drawImage(color, 0, 0);
      dirty = false;
    },
    clip: (top: number, right: number, bottom: number, left: number) => {
      color.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
    },
  };
}

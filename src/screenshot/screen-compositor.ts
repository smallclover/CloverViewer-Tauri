export interface ScreenImage {
  image: CanvasImageSource;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Paint every captured display over an opaque background. */
export function drawScreenBase(context: CanvasRenderingContext2D, screens: readonly ScreenImage[]) {
  context.fillStyle = "#14161c";
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  for (const screen of screens) {
    context.drawImage(screen.image, screen.x, screen.y, screen.w, screen.h);
  }
}

/**
 * Copy the overlapping portions of a root-local source region from one or more
 * display captures into a target rectangle.  This preserves the source/dest
 * coordinate separation needed by mosaic, magnifier, OCR, and export paths.
 */
export function blitScreenRegion(
  context: CanvasRenderingContext2D,
  screens: readonly ScreenImage[],
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
  destinationX: number,
  destinationY: number,
  destinationWidth: number,
  destinationHeight: number,
) {
  context.save();
  context.beginPath();
  context.rect(destinationX, destinationY, destinationWidth, destinationHeight);
  context.clip();
  context.imageSmoothingEnabled = true;
  for (const screen of screens) {
    const overlapX = Math.max(sourceX, screen.x);
    const overlapY = Math.max(sourceY, screen.y);
    const overlapEndX = Math.min(sourceX + sourceWidth, screen.x + screen.w);
    const overlapEndY = Math.min(sourceY + sourceHeight, screen.y + screen.h);
    if (overlapX >= overlapEndX || overlapY >= overlapEndY) continue;

    const scaleX = destinationWidth / sourceWidth;
    const scaleY = destinationHeight / sourceHeight;
    context.drawImage(
      screen.image,
      overlapX - screen.x,
      overlapY - screen.y,
      overlapEndX - overlapX,
      overlapEndY - overlapY,
      destinationX + (overlapX - sourceX) * scaleX,
      destinationY + (overlapY - sourceY) * scaleY,
      (overlapEndX - overlapX) * scaleX,
      (overlapEndY - overlapY) * scaleY,
    );
  }
  context.restore();
}

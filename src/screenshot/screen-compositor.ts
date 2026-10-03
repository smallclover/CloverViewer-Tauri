export interface ScreenImage {
  image: CanvasImageSource;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 在不透明底图上绘制每一块已采集的显示器画面。 */
export function drawScreenBase(context: CanvasRenderingContext2D, screens: readonly ScreenImage[]) {
  context.fillStyle = "#14161c";
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  for (const screen of screens) {
    context.drawImage(screen.image, screen.x, screen.y, screen.w, screen.h);
  }
}

/**
 * 把根坐标下的源区域中与各显示器重叠的部分，复制到目标矩形。
 * 由此保持源坐标与目标坐标分离，供马赛克、放大镜、OCR 与导出使用。
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

import { rotateVector, shapeBBox, type Pt, type Shape } from "./geometry";

/** 在标注自己的坐标系计算选框，避免旋转时使用随角度变大的轴对齐包围盒。 */
export function annotationFrame(shape: Shape) {
  const angle = shape.rotation ?? 0;
  const local = (point: Pt) => rotateVector(point, -angle);
  const box = shapeBBox({
    ...shape,
    rotation: 0,
    start: local(shape.start),
    end: local(shape.end),
    points: shape.points?.map(local),
  });
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((point) => rotateVector(point, angle));
  return { ...box, angle, corners };
}

/** 光标不会随 DOM 的 CSS 变换旋转，需显式按角点及标注方向生成。 */
export function annotationRotationCursor(angle: number) {
  // 按一度缓存，随角点连续转向，同时避免浮点误差生成无限多张光标图像。
  const direction = ((Math.round(angle) % 360) + 360) % 360;
  let cursor = rotationCursors.get(direction);
  if (!cursor) {
    const path = "M6 18 10 25 14 18H11A7 7 0 0 1 18 11V14L25 10 18 6V9A9 9 0 0 0 9 18Z";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path transform="rotate(${direction} 16 16)" d="${path}" fill="#111" stroke="white" stroke-width="1.25" stroke-linejoin="round"/></svg>`;
    cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
    rotationCursors.set(direction, cursor);
  }
  return cursor;
}

const rotationCursors = new Map<number, string>();

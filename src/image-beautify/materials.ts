import type { BeautyRect } from "./layout";

const textures = new Map<string, HTMLCanvasElement>();
function noise(seed = 1979) {
  return () => {
    seed = Math.imul(seed ^ (seed >>> 16), 2246822519);
    seed = Math.imul(seed ^ (seed >>> 13), 3266489917);
    return (seed >>> 0) / 4294967296;
  };
}

function woodTexture(color: string) {
  const key = `wood:${color}`;
  const cached = textures.get(key);
  if (cached) return cached;
  const tile = document.createElement("canvas");
  tile.width = 256;
  tile.height = 96;
  const context = tile.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.fillStyle = color;
  context.fillRect(0, 0, tile.width, tile.height);
  const random = noise();
  for (let i = 0; i < 130; i++) {
    const y = random() * tile.height,
      wave = random() * 5;
    context.strokeStyle =
      i % 3
        ? `rgba(80,43,14,${0.025 + random() * 0.055})`
        : `rgba(255,237,197,${0.06 + random() * 0.12})`;
    context.lineWidth = 0.3 + random() * 1.1;
    context.beginPath();
    context.moveTo(0, y);
    context.bezierCurveTo(80, y + wave, 176, y - wave, 256, y);
    context.stroke();
  }
  textures.set(key, tile);
  if (textures.size > 8) {
    const first = textures.keys().next().value;
    if (first) textures.delete(first);
  }
  return tile;
}

export function paintPaper(
  context: CanvasRenderingContext2D,
  rect: BeautyRect,
  color: string,
  scale: number,
) {
  context.fillStyle = color;
  context.fillRect(rect.x, rect.y, rect.w, rect.h);
  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.w, rect.h);
  context.clip();
  let tile = textures.get("paper");
  if (!tile) {
    tile = document.createElement("canvas");
    tile.width = tile.height = 128;
    const target = tile.getContext("2d");
    if (!target) throw new Error("Canvas 2D is unavailable");
    const random = noise(8101);
    target.fillStyle = "#5146370a";
    for (let i = 0; i < 360; i++)
      target.fillRect(random() * 128, random() * 128, 0.6, 0.6 + random());
    textures.set("paper", tile);
  }
  const pattern = context.createPattern(tile, "repeat");
  if (pattern) {
    context.translate(rect.x, rect.y);
    context.scale(scale, scale);
    context.fillStyle = pattern;
    context.fillRect(0, 0, rect.w / scale, rect.h / scale);
  }
  context.restore();
}

export function paintWood(
  context: CanvasRenderingContext2D,
  shell: BeautyRect,
  rail: number,
  color: string,
  scale: number,
) {
  if (rail <= 0) return;
  const { x, y, w, h } = shell,
    r = Math.min(rail, w / 2, h / 2);
  const pattern = context.createPattern(woodTexture(color), "repeat");
  if (!pattern) return;
  const faces = [
    [
      [x, y],
      [x + w, y],
      [x + w - r, y + r],
      [x + r, y + r],
    ],
    [
      [x + w, y],
      [x + w, y + h],
      [x + w - r, y + h - r],
      [x + w - r, y + r],
    ],
    [
      [x, y + h],
      [x + r, y + h - r],
      [x + w - r, y + h - r],
      [x + w, y + h],
    ],
    [
      [x, y],
      [x + r, y + r],
      [x + r, y + h - r],
      [x, y + h],
    ],
  ];
  faces.forEach((points, i) => {
    context.save();
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (const point of points.slice(1)) context.lineTo(point[0], point[1]);
    context.closePath();
    context.clip();
    context.save();
    context.translate(x, y);
    if (i % 2) context.rotate(Math.PI / 2);
    context.scale(scale, scale);
    context.fillStyle = pattern;
    const extent = (w + h) / scale;
    context.fillRect(-extent, -extent, extent * 2, extent * 2);
    context.restore();
    const gradient =
      i % 2
        ? context.createLinearGradient(i === 1 ? x + w : x, y, i === 1 ? x + w - r : x + r, y)
        : context.createLinearGradient(x, i === 0 ? y : y + h, x, i === 0 ? y + r : y + h - r);
    gradient.addColorStop(0, i === 0 || i === 3 ? "#fff5" : "#61401d55");
    gradient.addColorStop(0.22, "#ffffff08");
    gradient.addColorStop(0.8, "#00000008");
    gradient.addColorStop(1, "#71471b50");
    context.fillStyle = gradient;
    context.fillRect(x, y, w, h);
    context.restore();
  });
  context.strokeStyle = "#68442144";
  context.lineWidth = Math.max(0.5, scale);
  for (const [ax, ay, bx, by] of [
    [x, y, x + r, y + r],
    [x + w, y, x + w - r, y + r],
    [x + w, y + h, x + w - r, y + h - r],
    [x, y + h, x + r, y + h - r],
  ]) {
    context.beginPath();
    context.moveTo(ax, ay);
    context.lineTo(bx, by);
    context.stroke();
  }
}

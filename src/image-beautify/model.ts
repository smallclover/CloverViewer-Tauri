import type {
  BeautifyBackground,
  BeautifyDocument,
  BeautifyFrame,
  BeautifyFrameStyle,
  BeautifyWatermark,
} from "../api";

export const defaultFrameStyle = (): BeautifyFrameStyle => ({
  title: "",
  url: "",
  compact: false,
  titleBarHeight: 64,
  railWidth: 24,
  matWidth: 48,
  matColor: "#f4f1e9",
  innerWidth: 3,
  accentColor: "#a8a093",
  paperBottom: 96,
  caption: "",
  captionDate: false,
});
export const frameStyle = (frame: BeautifyFrame): BeautifyFrameStyle => ({
  ...defaultFrameStyle(),
  ...frame.style,
});
export function beautyBackground(document: BeautifyDocument): BeautifyBackground {
  const frame = document.frame;
  if (frame.kind === "solid" || frame.kind === "gradient")
    return {
      kind: frame.kind,
      color: frame.background,
      endColor: frame.backgroundEnd,
      angle: frame.angle,
    };
  return (
    document.background ?? {
      kind: "transparent",
      color: frame.background,
      endColor: frame.backgroundEnd,
      angle: frame.angle,
    }
  );
}

/** Upgrade v1 documents without changing their geometry, colors, IDs or watermark positions. */
export function migrateBeauty(value: BeautifyDocument): BeautifyDocument {
  const result = cloneBeauty(value);
  result.background = beautyBackground(result);
  if (result.frame.kind === "solid" || result.frame.kind === "gradient") result.frame.kind = "card";
  return result;
}

export const cloneBeauty = (value: BeautifyDocument): BeautifyDocument =>
  JSON.parse(JSON.stringify(value));

/** Key order from Rust serialization or preset assignment is not an image edit. */
export function beautyKey(value: BeautifyDocument): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, stable(v)]),
      );
    return value;
  };
  return JSON.stringify(stable(value));
}

export function emptyBeauty(referenceSize = 1000): BeautifyDocument {
  return {
    enabled: false,
    referenceSize: Math.max(1, referenceSize),
    frame: {
      kind: "none",
      padding: [48, 48, 48, 48],
      borderWidth: 2,
      borderColor: "#ffffff",
      background: "#eef2f0",
      backgroundEnd: "#a8d5ba",
      angle: 135,
      radius: 16,
      shadow: 16,
    },
    watermarks: [],
    background: { kind: "transparent", color: "#e6ede8", endColor: "#bdcec5", angle: 135 },
  };
}

export function newWatermark(kind: "text" | "image"): BeautifyWatermark {
  return {
    id: crypto.randomUUID(),
    kind,
    enabled: true,
    text: "© CloverViewer",
    assetId: "",
    font: "sans",
    fontSize: 24,
    color: "#ffffff",
    opacity: 0.5,
    outline: 1,
    rotation: 0,
    placement: "single",
    region: "content",
    anchor: 8,
    x: -20,
    y: -20,
    width: 120,
    gapX: 80,
    gapY: 60,
  };
}

export const beautyScale = (value: BeautifyDocument, width: number, height: number) =>
  Math.min(width, height) / Math.max(1, value.referenceSize);

/** Rebase numeric controls to current image pixels; presets retain their proportional layout. */
export function rebaseBeauty(value: BeautifyDocument, width: number, height: number) {
  const copy = cloneBeauty(value);
  const scale = beautyScale(copy, width, height);
  copy.referenceSize = Math.max(1, Math.min(width, height));
  copy.frame.padding = copy.frame.padding.map((n) => n * scale) as typeof copy.frame.padding;
  for (const key of ["borderWidth", "radius", "shadow"] as const) copy.frame[key] *= scale;
  if (copy.frame.style)
    for (const key of [
      "titleBarHeight",
      "railWidth",
      "matWidth",
      "innerWidth",
      "paperBottom",
    ] as const)
      copy.frame.style[key] *= scale;
  for (const layer of copy.watermarks)
    for (const key of ["fontSize", "outline", "x", "y", "width", "gapX", "gapY"] as const)
      layer[key] *= scale;
  return copy;
}

export function resolveWatermarkText(text: string, time: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return text
    .replaceAll(
      "{date}",
      `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`,
    )
    .replaceAll(
      "{time}",
      `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`,
    );
}

import type { BeautifyDocument } from "../api";
import type { Rect } from "../image-editor/geometry";
import { loadBeautyAssets } from "./assets";
import { renderBeauty } from "./renderer";

/** Small source and finished canvases are reused until image content or crop changes. */
export function createBeautyThumbnails(options: {
  source: HTMLCanvasElement;
  getCrop: () => Rect | null;
  getTime: () => Date;
}) {
  const cache = new Map<string, Promise<HTMLCanvasElement>>();
  const targets = new Map<HTMLCanvasElement, BeautifyDocument>();
  let source: HTMLCanvasElement | null = null,
    generation = 0;
  function snapshot() {
    if (source) return source;
    const crop = options.getCrop() ?? {
      x: 0,
      y: 0,
      w: options.source.width,
      h: options.source.height,
    };
    const factor = Math.min(1, 420 / Math.max(crop.w, crop.h));
    source = document.createElement("canvas");
    source.width = Math.max(1, Math.round(crop.w * factor));
    source.height = Math.max(1, Math.round(crop.h * factor));
    source
      .getContext("2d")
      ?.drawImage(
        options.source,
        crop.x,
        crop.y,
        crop.w,
        crop.h,
        0,
        0,
        source.width,
        source.height,
      );
    return source;
  }
  async function paint(target: HTMLCanvasElement, beauty: BeautifyDocument) {
    const current = generation;
    const key = JSON.stringify(beauty);
    if (!cache.has(key)) {
      const content = snapshot(),
        time = options.getTime();
      const pending = (async () => {
        const assets = new Map<string, HTMLImageElement>(),
          missing = new Set<string>();
        await Promise.all(
          beauty.watermarks
            .filter((w) => w.enabled && w.kind === "image")
            .map(async (w) => {
              try {
                for (const [id, image] of await loadBeautyAssets({ ...beauty, watermarks: [w] }))
                  assets.set(id, image);
              } catch {
                missing.add(w.id);
              }
            }),
        );
        if (current !== generation) return document.createElement("canvas");
        return renderBeauty({
          source: content,
          document: { ...beauty, watermarks: beauty.watermarks.filter((w) => !missing.has(w.id)) },
          time,
          assets,
          previewLimit: 260,
        }).canvas;
      })();
      cache.set(key, pending);
      void pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
      if (cache.size > 24) {
        const first = cache.keys().next().value;
        if (first) {
          const evicted = cache.get(first);
          cache.delete(first);
          void evicted?.then(
            (canvas) => {
              canvas.width = canvas.height = 0;
            },
            () => {},
          );
        }
      }
    }
    try {
      const result = await cache.get(key);
      if (!result || current !== generation || !target.isConnected) return;
      target.width = result.width;
      target.height = result.height;
      target.getContext("2d")?.drawImage(result, 0, 0);
    } catch {
      target.width = target.height = 1;
    }
  }
  function invalidate(refresh = true) {
    generation++;
    if (source) source.width = source.height = 0;
    source = null;
    for (const canvas of cache.values())
      void canvas.then(
        (c) => {
          c.width = c.height = 0;
        },
        () => {},
      );
    cache.clear();
    for (const [target, beauty] of targets) {
      if (!target.isConnected || !refresh) targets.delete(target);
      else void paint(target, beauty);
    }
  }
  return {
    paint(target: HTMLCanvasElement, beauty: BeautifyDocument) {
      for (const node of targets.keys()) if (!node.isConnected) targets.delete(node);
      targets.set(target, beauty);
      void paint(target, beauty);
    },
    invalidate,
  };
}

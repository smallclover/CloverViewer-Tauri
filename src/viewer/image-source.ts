import type { ImageEntry } from "../api";

interface ImageSourceApi {
  maxBytes?: number;
  fileSrc(path: string): string;
  readImageData(path: string): Promise<string>;
}

/** 返回图片可用的地址：Web 支持的格式走原生路径，否则回退到 data-URL（LRU 上限 20 条）。 */
export function createImageSourceResolver({
  fileSrc,
  readImageData,
  maxBytes = 64 * 1024 * 1024,
}: ImageSourceApi) {
  const decodedCache = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  let generation = 0;
  let cacheBytes = 0;

  return {
    clear() {
      decodedCache.clear();
      cacheBytes = 0;
      pending.clear();
      generation++;
    },
    async for(entry: ImageEntry): Promise<string> {
      if (entry.web_supported) return fileSrc(entry.path);
      const key = `${entry.path}\0${entry.modified}\0${entry.size}`;
      const cached = decodedCache.get(key);
      if (cached) {
        decodedCache.delete(key);
        decodedCache.set(key, cached);
        return cached;
      }
      const existing = pending.get(key);
      if (existing) return existing;

      const current = generation;
      const request = readImageData(entry.path)
        .then((dataUrl) => {
          if (current === generation && dataUrl.length * 2 <= maxBytes) {
            decodedCache.set(key, dataUrl);
            cacheBytes += dataUrl.length * 2;
            while (decodedCache.size > 20 || cacheBytes > maxBytes) {
              const first = decodedCache.keys().next().value;
              if (first === undefined) break;
              cacheBytes -= (decodedCache.get(first)?.length ?? 0) * 2;
              decodedCache.delete(first);
            }
          }
          return dataUrl;
        })
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
      pending.set(key, request);
      return request;
    },
  };
}

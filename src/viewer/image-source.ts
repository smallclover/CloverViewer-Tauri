import type { ImageEntry } from "../api";

interface ImageSourceApi {
  fileSrc(path: string): string;
  readImageData(path: string): Promise<string>;
}

/** 返回图片可用的地址：Web 支持的格式走原生路径，否则回退到 data-URL（LRU 上限 20 条）。 */
export function createImageSourceResolver({ fileSrc, readImageData }: ImageSourceApi) {
  const decodedCache = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  let generation = 0;

  return {
    clear() {
      decodedCache.clear();
      pending.clear();
      generation++;
    },
    async for(entry: ImageEntry): Promise<string> {
      if (entry.web_supported) return fileSrc(entry.path);
      const cached = decodedCache.get(entry.path);
      if (cached) {
        decodedCache.delete(entry.path);
        decodedCache.set(entry.path, cached);
        return cached;
      }
      const existing = pending.get(entry.path);
      if (existing) return existing;

      const current = generation;
      const request = readImageData(entry.path)
        .then((dataUrl) => {
          if (current === generation) {
            decodedCache.set(entry.path, dataUrl);
            if (decodedCache.size > 20) {
              const first = decodedCache.keys().next().value;
              if (first) decodedCache.delete(first);
            }
          }
          return dataUrl;
        })
        .finally(() => {
          if (pending.get(entry.path) === request) pending.delete(entry.path);
        });
      pending.set(entry.path, request);
      return request;
    },
  };
}

import type { ImageEntry } from "../api";

interface ImageSourceApi {
  fileSrc(path: string): string;
  readImageData(path: string): Promise<string>;
}

/** Resolves native image paths and bounds the fallback data-URL cache. */
export function createImageSourceResolver({ fileSrc, readImageData }: ImageSourceApi) {
  const decodedCache = new Map<string, string>();

  return {
    clear() {
      decodedCache.clear();
    },
    async for(entry: ImageEntry): Promise<string> {
      if (entry.web_supported) return fileSrc(entry.path);
      const cached = decodedCache.get(entry.path);
      if (cached) return cached;

      const dataUrl = await readImageData(entry.path);
      decodedCache.set(entry.path, dataUrl);
      if (decodedCache.size > 20) {
        const first = decodedCache.keys().next().value;
        if (first) decodedCache.delete(first);
      }
      return dataUrl;
    },
  };
}

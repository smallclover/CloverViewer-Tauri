import { readBeautifyAsset, type BeautifyDocument } from "../api";

const images = new Map<string, Promise<HTMLImageElement>>();
export async function loadBeautyAssets(document: BeautifyDocument) {
  const result = new Map<string, HTMLImageElement>();
  if (!document.enabled) return result;
  for (const layer of document.watermarks) {
    if (!layer.enabled || layer.kind !== "image") continue;
    const id = layer.assetId;
    if (!id) throw new Error("beautify.missingAsset");
    if (!images.has(id)) {
      const pending = readBeautifyAsset(id).then(
        (url) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("beautify.missingAsset"));
            image.src = url;
          }),
      );
      images.set(id, pending);
      if (images.size > 16) images.delete(images.keys().next().value as string);
      void pending.catch(() => images.delete(id));
    }
    try {
      const pending = images.get(id);
      if (!pending) throw new Error("beautify.missingAsset");
      result.set(id, await pending);
    } catch {
      throw new Error("beautify.missingAsset");
    }
  }
  return result;
}

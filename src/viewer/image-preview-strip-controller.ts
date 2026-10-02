import type { ImageEntry } from "../api";
import type { createImageSourceResolver } from "./image-source";
import type { createViewerSession } from "./viewer-session";
import { createThumbnailLoader } from "./thumbnail-loader";

interface ImagePreviewStripOptions {
  strip: HTMLElement;
  session: ReturnType<typeof createViewerSession>;
  imageSource: ReturnType<typeof createImageSourceResolver>;
  getThumbnail: (path: string, size: number) => Promise<string>;
  onSelect: (index: number) => void;
}

/** 渲染当前图片前后各两张的紧凑缩略图条，点击可切换。 */
export function createImagePreviewStripController(options: ImagePreviewStripOptions) {
  const buttons = new Map<string, HTMLButtonElement>();
  const thumbnailLoader = createThumbnailLoader({
    load: options.getThumbnail,
    cacheCapacity: 32,
    maxConcurrent: 2,
  });
  const keyFor = (entry: ImageEntry) => `${entry.path}\0${entry.modified}\0${entry.size}`;

  const sourceFor = async (entry: ImageEntry) => {
    try {
      return await thumbnailLoader.load(entry.path, 120);
    } catch {
      return options.imageSource.for(entry);
    }
  };

  const render = (activeIndex: number) => {
    const start = Math.max(0, activeIndex - 2);
    const end = Math.min(options.session.images.length, activeIndex + 3);
    const entries = options.session.images.slice(start, end);
    const keys = new Set(entries.map(keyFor));
    thumbnailLoader.retain(
      new Set(entries.map((entry) => thumbnailLoader.keyFor(entry.path, 120))),
    );
    for (const [key, button] of buttons) {
      if (keys.has(key)) continue;
      button.remove();
      buttons.delete(key);
    }

    for (let index = start; index < end; index += 1) {
      const entry = options.session.images[index];
      const key = keyFor(entry);
      const existing = buttons.get(key);
      if (existing) {
        existing.classList.toggle("active", index === activeIndex);
        if (options.strip.children[index - start] !== existing) {
          options.strip.insertBefore(existing, options.strip.children[index - start] ?? null);
        }
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = `image-preview${index === activeIndex ? " active" : ""}`;
      button.ariaLabel = entry.name;
      button.title = entry.name;

      const image = document.createElement("img");
      image.alt = "";
      image.draggable = false;
      button.appendChild(image);
      button.addEventListener("mousedown", (event) => event.stopPropagation());
      button.addEventListener("dblclick", (event) => event.stopPropagation());
      button.addEventListener("click", () => {
        const selected = options.session.images.findIndex((image) => image.path === entry.path);
        if (selected >= 0) options.onSelect(selected);
      });
      options.strip.insertBefore(button, options.strip.children[index - start] ?? null);
      buttons.set(key, button);

      void sourceFor(entry)
        .then((source) => {
          if (source && buttons.get(key) === button) image.src = source;
        })
        .catch(() => {});
    }
  };

  return {
    render,
    clear() {
      thumbnailLoader.clear();
      thumbnailLoader.retain(new Set());
      for (const button of buttons.values()) button.remove();
      buttons.clear();
    },
  };
}

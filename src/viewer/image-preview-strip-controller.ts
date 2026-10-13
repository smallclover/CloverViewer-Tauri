import type { ImageEntry } from "../api";
import type { createImageSourceResolver } from "./image-source";
import type { createViewerSession } from "./viewer-session";
import { createThumbnailLoader } from "./thumbnail-loader";

const PREVIEW_THUMBNAIL_SIZE = 192;

interface ImagePreviewStripOptions {
  strip: HTMLElement;
  toggle: HTMLButtonElement;
  session: ReturnType<typeof createViewerSession>;
  imageSource: ReturnType<typeof createImageSourceResolver>;
  getThumbnail: (path: string, size: number) => Promise<string>;
  onSelect: (index: number) => void;
  onToggle: () => void;
  translate: (key: string) => string;
}

/** 管理底部悬浮预览条及其即时开关，复用当前图片前后各两张的缩略图。 */
export function createImagePreviewStripController(options: ImagePreviewStripOptions) {
  const buttons = new Map<string, HTMLButtonElement>();
  const thumbnailLoader = createThumbnailLoader({
    load: options.getThumbnail,
    cacheCapacity: 32,
    maxConcurrent: 2,
  });
  const keyFor = (entry: ImageEntry) => `${entry.path}\0${entry.modified}\0${entry.size}`;
  let visible = true;

  const centerActive = () => {
    const active = options.strip.querySelector<HTMLElement>(".active");
    if (active && visible) {
      options.strip.scrollLeft =
        active.offsetLeft + active.offsetWidth / 2 - options.strip.clientWidth / 2;
    }
  };
  new ResizeObserver(centerActive).observe(options.strip);
  options.toggle.addEventListener("click", options.onToggle);
  for (const event of ["mousedown", "dblclick", "wheel"]) {
    options.strip.addEventListener(event, (input) => input.stopPropagation());
  }
  for (const control of [options.strip, options.toggle]) {
    control.addEventListener("keydown", (event) => {
      // 预览控件内的 Tab 保留焦点导航，不触发查看器的网格切换快捷键。
      if (event.key === "Tab") event.stopPropagation();
    });
  }

  const setVisible = (enabled: boolean) => {
    visible = enabled;
    options.strip.classList.toggle("hidden", !visible);
    options.toggle.classList.toggle("active", visible);
    options.toggle.ariaExpanded = String(visible);
    const key = visible ? "view.hideImagePreviews" : "view.showImagePreviews";
    options.toggle.dataset.i18nTitle = key;
    options.toggle.dataset.i18nAriaLabel = key;
    options.toggle.title = options.translate(key);
    options.toggle.ariaLabel = options.translate(key);
    centerActive();
  };

  const sourceFor = async (entry: ImageEntry) => {
    try {
      return await thumbnailLoader.load(entry.path, PREVIEW_THUMBNAIL_SIZE);
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
      new Set(entries.map((entry) => thumbnailLoader.keyFor(entry.path, PREVIEW_THUMBNAIL_SIZE))),
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
        existing.setAttribute("aria-current", String(index === activeIndex));
        if (options.strip.children[index - start] !== existing) {
          options.strip.insertBefore(existing, options.strip.children[index - start] ?? null);
        }
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = `image-preview${index === activeIndex ? " active" : ""}`;
      button.setAttribute("aria-current", String(index === activeIndex));
      button.ariaLabel = entry.name;
      button.title = entry.name;

      const image = document.createElement("img");
      image.alt = "";
      image.draggable = false;
      button.appendChild(image);
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
    centerActive();
  };

  return {
    render,
    setVisible,
    setAvailable: (available: boolean) => {
      options.toggle.classList.toggle("hidden", !available);
    },
    clear() {
      thumbnailLoader.clear();
      thumbnailLoader.retain(new Set());
      for (const button of buttons.values()) button.remove();
      buttons.clear();
    },
  };
}

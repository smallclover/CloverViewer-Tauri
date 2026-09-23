import type { ImageEntry } from "../api";
import type { createImageSourceResolver } from "./image-source";
import type { createViewerSession } from "./viewer-session";

interface ImagePreviewStripOptions {
  strip: HTMLElement;
  session: ReturnType<typeof createViewerSession>;
  imageSource: ReturnType<typeof createImageSourceResolver>;
  getThumbnail: (path: string, size: number) => Promise<string>;
  onSelect: (index: number) => void;
}

/** Renders a compact, clickable window around the active image. */
export function createImagePreviewStripController(options: ImagePreviewStripOptions) {
  let renderId = 0;

  const sourceFor = async (entry: ImageEntry) => {
    try {
      return await options.getThumbnail(entry.path, 120);
    } catch {
      return options.imageSource.for(entry);
    }
  };

  const render = (activeIndex: number) => {
    const id = ++renderId;
    options.strip.innerHTML = "";
    const start = Math.max(0, activeIndex - 2);
    const end = Math.min(options.session.images.length, activeIndex + 3);

    for (let index = start; index < end; index += 1) {
      const entry = options.session.images[index];
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
      button.addEventListener("click", () => options.onSelect(index));
      options.strip.appendChild(button);

      void sourceFor(entry).then((source) => {
        if (id === renderId) image.src = source;
      });
    }
  };

  return { render };
}

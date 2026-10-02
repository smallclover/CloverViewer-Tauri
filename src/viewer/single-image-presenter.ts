import type { ImageEntry } from "../api";
import { createSingleImageLoader } from "./single-image-loader";

interface SingleImagePresenterOptions {
  getImage: () => HTMLImageElement;
  sourceFor: (entry: ImageEntry) => Promise<string>;
  isActive: () => boolean;
  onCommit: (image: HTMLImageElement) => void;
  onError: (error: unknown) => void;
}

/** Swaps already-decoded images while keeping the previous frame visible during loading. */
export function createSingleImagePresenter(options: SingleImagePresenterOptions) {
  const loader = createSingleImageLoader({ sourceFor: options.sourceFor });
  let revision = 0;
  let outgoing: HTMLImageElement | null = null;
  let animations: Animation[] = [];
  let pending: Promise<boolean> = Promise.resolve(false);
  const stopTransition = () => {
    for (const animation of animations) animation.cancel();
    animations = [];
    outgoing?.remove();
    outgoing = null;
  };
  const cancel = () => {
    revision++;
    stopTransition();
  };

  const show = async (entry: ImageEntry, neighbors: readonly ImageEntry[]) => {
    const current = ++revision;
    loader.retain([entry, ...neighbors]);
    try {
      const image = await loader.load(entry);
      if (!image || current !== revision || !options.isActive()) return false;
      stopTransition();
      const previous = options.getImage();
      if (image !== previous) {
        previous.removeAttribute("id");
        previous.classList.add("single-image", "single-image-outgoing");
        previous.setAttribute("aria-hidden", "true");
        image.id = "single-img";
        image.className = "single-image";
        image.dataset.imagePath = entry.path;
        image.removeAttribute("aria-hidden");
        previous.after(image);
        options.onCommit(image);
        if (
          previous.naturalWidth &&
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          outgoing = previous;
          const timing = { duration: 120, easing: "ease-out" };
          animations = [
            previous.animate([{ opacity: 1 }, { opacity: 0 }], timing),
            image.animate([{ opacity: 0 }, { opacity: 1 }], timing),
          ];
          void Promise.all(animations.map((animation) => animation.finished))
            .then(() => {
              if (outgoing === previous) stopTransition();
            })
            .catch(() => {});
        } else previous.remove();
      } else options.onCommit(image);
      loader.preload(neighbors);
      return true;
    } catch (error) {
      if (current === revision && options.isActive()) options.onError(error);
      return false;
    }
  };
  return {
    show(entry: ImageEntry, neighbors: readonly ImageEntry[]) {
      pending = show(entry, neighbors);
      return pending;
    },
    whenReady: () => pending,
    cancel,
    clear() {
      cancel();
      loader.clear();
      // A new directory must not briefly reveal the previous directory's image.
      options.getImage().removeAttribute("src");
      options.getImage().removeAttribute("data-image-path");
    },
  };
}

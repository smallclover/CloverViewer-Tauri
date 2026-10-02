import type { ImageEntry } from "../api";

interface SingleImageLoaderOptions {
  sourceFor: (entry: ImageEntry) => Promise<string>;
  createImage?: () => HTMLImageElement;
  maxBytes?: number;
}

interface ImageTask {
  key: string;
  entry: ImageEntry;
  image: HTMLImageElement;
  bytes: number;
  cancelled: boolean;
  promise: Promise<HTMLImageElement | null>;
  resolve: (image: HTMLImageElement | null) => void;
  reject: (error: unknown) => void;
}

/** Keeps a small decoded neighborhood and gives current selections priority over warmup. */
export function createSingleImageLoader(options: SingleImageLoaderOptions) {
  const maxBytes = options.maxBytes ?? 96 * 1024 * 1024;
  const cache = new Map<string, ImageTask>();
  let queued: ImageTask[] = [];
  let active = 0;
  let foregroundKey = "";
  const keyFor = (entry: ImageEntry) => `${entry.path}\0${entry.modified}\0${entry.size}`;
  const bytesFor = (entry: ImageEntry) => Math.max(0, entry.width * entry.height * 4);
  const usedBytes = () => [...cache.values()].reduce((sum, task) => sum + task.bytes, 0);

  const discard = (task: ImageTask) => {
    if (cache.get(task.key) === task) cache.delete(task.key);
    task.cancelled = true;
    task.resolve(null);
    if (!task.image.isConnected) task.image.removeAttribute("src");
  };
  const trim = (keep: string) => {
    for (const task of cache.values()) {
      if (cache.size <= 3 && (usedBytes() <= maxBytes || cache.size === 1)) break;
      if (task.key !== keep) discard(task);
    }
  };
  const runQueued = () => {
    while (active < 2 && queued.length) {
      const task = queued.shift();
      if (!task || task.cancelled) continue;
      active++;
      void (async () => {
        const source = await options.sourceFor(task.entry);
        if (task.cancelled) return;
        task.image.src = source;
        await task.image.decode();
        if (task.cancelled) return;
        if (!task.image.naturalWidth || !task.image.naturalHeight) {
          throw new Error("Image has no decoded pixels");
        }
        task.bytes = task.image.naturalWidth * task.image.naturalHeight * 4;
        trim(foregroundKey);
        task.resolve(task.image);
      })()
        .catch((error) => {
          if (task.cancelled) return;
          cache.delete(task.key);
          task.reject(error);
        })
        .finally(() => {
          active--;
          runQueued();
        });
    }
  };
  const request = (entry: ImageEntry, foreground: boolean) => {
    const key = keyFor(entry);
    if (foreground) foregroundKey = key;
    const existing = cache.get(key);
    if (existing) {
      cache.delete(key);
      cache.set(key, existing);
      if (foreground && queued.includes(existing)) {
        queued = [existing, ...queued.filter((task) => task !== existing)];
      }
      return existing.promise;
    }
    const image = options.createImage?.() ?? new Image();
    image.decoding = "async";
    image.draggable = false;
    image.alt = entry.name;
    let resolve!: ImageTask["resolve"];
    let reject!: ImageTask["reject"];
    const promise = new Promise<HTMLImageElement | null>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const task: ImageTask = {
      key,
      entry,
      image,
      bytes: bytesFor(entry),
      cancelled: false,
      promise,
      resolve,
      reject,
    };
    cache.set(key, task);
    trim(key);
    if (foreground) queued.unshift(task);
    else queued.push(task);
    runQueued();
    return promise;
  };

  return {
    load: (entry: ImageEntry) => request(entry, true),
    preload(entries: readonly ImageEntry[]) {
      for (const entry of entries) {
        if (cache.has(keyFor(entry))) continue;
        if (cache.size >= 3 || usedBytes() + bytesFor(entry) > maxBytes) continue;
        void request(entry, false).catch(() => {});
      }
    },
    retain(entries: readonly ImageEntry[]) {
      const keys = new Set(entries.map(keyFor));
      for (const task of cache.values()) if (!keys.has(task.key)) discard(task);
      queued = queued.filter((task) => !task.cancelled);
    },
    clear() {
      for (const task of cache.values()) discard(task);
      queued = [];
      foregroundKey = "";
    },
  };
}

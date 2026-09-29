interface ThumbnailLoaderOptions {
  load: (path: string, size: number) => Promise<string>;
  maxConcurrent?: number;
  cacheCapacity?: number;
}

interface ThumbnailTask {
  key: string;
  path: string;
  size: number;
  promise: Promise<string | undefined>;
  resolve: (value: string | undefined) => void;
  reject: (reason: unknown) => void;
}

/**
 * Bounds native thumbnail work while a virtualized grid is moving.
 *
 * A task that leaves the visible range before it starts resolves to undefined;
 * work already handed to Tauri is allowed to finish and seed the small LRU.
 */
export function createThumbnailLoader(options: ThumbnailLoaderOptions) {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
  const cacheCapacity = Math.max(1, options.cacheCapacity ?? 96);
  const cache = new Map<string, string>();
  const tasks = new Map<string, ThumbnailTask>();
  let queued: ThumbnailTask[] = [];
  let activeCount = 0;

  const keyFor = (path: string, size: number) => `${size}\0${path}`;

  const cacheValue = (key: string, value: string) => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > cacheCapacity) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const readCached = (key: string) => {
    const value = cache.get(key);
    if (value === undefined) return undefined;
    cache.delete(key);
    cache.set(key, value);
    return value;
  };

  const startQueued = () => {
    while (activeCount < maxConcurrent && queued.length > 0) {
      const task = queued.shift();
      if (!task || tasks.get(task.key) !== task) continue;
      activeCount += 1;
      void options
        .load(task.path, task.size)
        .then((value) => {
          cacheValue(task.key, value);
          task.resolve(value);
        })
        .catch(task.reject)
        .finally(() => {
          activeCount -= 1;
          if (tasks.get(task.key) === task) tasks.delete(task.key);
          startQueued();
        });
    }
  };

  const load = (path: string, size: number): Promise<string | undefined> => {
    const key = keyFor(path, size);
    const cached = readCached(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const existing = tasks.get(key);
    if (existing) return existing.promise;

    let resolve!: (value: string | undefined) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<string | undefined>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const task: ThumbnailTask = { key, path, size, promise, resolve, reject };
    tasks.set(key, task);
    queued.push(task);
    startQueued();
    return promise;
  };

  return {
    keyFor,
    load,
    /** Drops queued work which no longer has a visible consumer. */
    retain(keys: ReadonlySet<string>) {
      queued = queued.filter((task) => {
        if (keys.has(task.key)) return true;
        if (tasks.get(task.key) === task) tasks.delete(task.key);
        task.resolve(undefined);
        return false;
      });
    },
    clear() {
      cache.clear();
    },
  };
}

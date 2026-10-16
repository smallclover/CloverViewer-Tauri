interface ThumbnailLoaderOptions {
  load: (path: string, size: number) => Promise<string>;
  maxConcurrent?: number;
  cacheCapacity?: number;
  maxCacheBytes?: number;
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
 * 在虚拟化网格滚动时限制原生缩略图任务的开销。
 *
 * 尚未开始就已离开可见范围的任务会以 undefined 结束；
 * 已交给 Tauri 的任务则允许跑完，并写入小容量 LRU 缓存。
 */
export function createThumbnailLoader(options: ThumbnailLoaderOptions) {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
  const cacheCapacity = Math.max(1, options.cacheCapacity ?? 96);
  const maxCacheBytes = options.maxCacheBytes ?? 16 * 1024 * 1024;
  let cacheBytes = 0;
  const cache = new Map<string, string>();
  const tasks = new Map<string, ThumbnailTask>();
  let queued: ThumbnailTask[] = [];
  let activeCount = 0;

  const keyFor = (path: string, size: number) => `${size}\0${path}`;

  const cacheValue = (key: string, value: string) => {
    if (value.length * 2 > maxCacheBytes) return;
    cacheBytes -= (cache.get(key)?.length ?? 0) * 2;
    cache.delete(key);
    cache.set(key, value);
    cacheBytes += value.length * 2;
    while (cache.size > cacheCapacity || cacheBytes > maxCacheBytes) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cacheBytes -= (cache.get(oldest)?.length ?? 0) * 2;
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
          if (tasks.get(task.key) !== task) return;
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
    /** 丢弃已无可见消费者的排队任务。 */
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
      cacheBytes = 0;
      for (const task of tasks.values()) task.resolve(undefined);
      tasks.clear();
      queued = [];
    },
  };
}

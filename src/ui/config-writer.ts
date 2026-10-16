/** 顺序保存独立设置补丁，失败只撤销该补丁，保留后续尚未保存的选择。 */
export function createConfigWriter<T extends object>(options: {
  read: () => T | null;
  render: (config: T) => void;
  persist: (config: T) => Promise<T>;
}) {
  let committed: T | null = null;
  let running = false;
  const jobs: { patch: Partial<T>; resolve: () => void; reject: (error: unknown) => void }[] = [];
  const render = () => {
    if (!committed) return;
    const optimistic = { ...committed };
    for (const job of jobs) Object.assign(optimistic, job.patch);
    options.render(optimistic);
  };
  const flush = async () => {
    running = true;
    while (jobs.length && committed) {
      const job = jobs[0];
      let failure: unknown;
      let failed = false;
      try {
        committed = await options.persist({ ...committed, ...job.patch });
      } catch (error) {
        failed = true;
        failure = error;
      }
      jobs.shift();
      render();
      if (failed) job.reject(failure);
      else job.resolve();
    }
    running = false;
  };
  return {
    save(patch: Partial<T>) {
      if (!running) committed = options.read();
      if (!committed) return Promise.reject(new Error("Configuration unavailable"));
      const pending = new Promise<void>((resolve, reject) => jobs.push({ patch, resolve, reject }));
      render();
      if (!running) void flush();
      return pending;
    },
  };
}

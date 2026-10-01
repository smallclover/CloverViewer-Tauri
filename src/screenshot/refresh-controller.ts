interface ScreenshotRefreshOptions {
  refreshConfig: () => Promise<void>;
  loadScreenshot: () => Promise<number | null>;
  showScreenshot: (captureId: number) => Promise<boolean>;
  clearScreenshot: () => void;
  applyScrollStartMode: () => Promise<void>;
}

/** Serialize startup and refresh events; a hidden warmup has nothing to show. */
export function createScreenshotRefreshController(options: ScreenshotRefreshOptions) {
  let revision = 0;
  let pending = false;
  let running: Promise<void> | null = null;

  const drain = async () => {
    while (pending) {
      pending = false;
      const current = revision;
      await options.refreshConfig();
      if (current !== revision) continue;
      const loaded = await options.loadScreenshot();
      if (loaded === null || current !== revision) continue;
      const shown = await options.showScreenshot(loaded);
      if (shown && current === revision) await options.applyScrollStartMode();
    }
  };
  const refresh = () => {
    revision++;
    pending = true;
    if (!running) {
      running = drain().finally(() => {
        running = null;
      });
    }
    return running;
  };
  const clear = () => {
    revision++;
    pending = false;
    options.clearScreenshot();
  };
  return { refresh, clear };
}

interface FrameUpdateOptions {
  request?: (callback: FrameRequestCallback) => number;
  cancel?: (id: number) => void;
}

/** 每帧只保留最新一次输入，并支持在指针释放时同步补一次最终刷新。 */
export function createFrameUpdate<T>(apply: (value: T) => void, options: FrameUpdateOptions = {}) {
  const request = options.request ?? requestAnimationFrame;
  const cancel = options.cancel ?? cancelAnimationFrame;
  let frame: number | null = null;
  let pending: { value: T } | null = null;
  const flush = () => {
    if (frame !== null) cancel(frame);
    frame = null;
    const latest = pending;
    pending = null;
    if (latest) apply(latest.value);
  };
  return {
    push: (value: T) => {
      pending = { value };
      if (frame === null) frame = request(flush);
    },
    flush,
    discard: () => {
      if (frame !== null) cancel(frame);
      frame = null;
      pending = null;
    },
  };
}

/** 合并状态查询；停止后或替换面板后，旧查询不得回写 UI。 */
export function watchShareStatus(options: {
  seconds: number;
  read: () => Promise<boolean>;
  onTick: (seconds: number) => void;
  onExpired: () => void;
  onUnavailable?: () => void;
}) {
  const deadline = Date.now() + options.seconds * 1000;
  let stopped = false,
    checking = false,
    unavailable = false;
  let timer: number | undefined;
  let checkingSince = 0;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) window.clearInterval(timer);
  };
  const expire = () => {
    if (stopped) return;
    stop();
    options.onExpired();
  };
  const tick = () => {
    if (stopped) return;
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (!unavailable) options.onTick(remaining);
    if (!remaining) {
      expire();
      return;
    }
    if (checking) {
      if (!unavailable && Date.now() - checkingSince >= 5000) {
        unavailable = true;
        options.onUnavailable?.();
      }
      return;
    }
    checking = true;
    checkingSince = Date.now();
    void options
      .read()
      .then((active) => {
        if (stopped) return;
        if (!active) {
          expire();
          return;
        }
        if (unavailable) {
          unavailable = false;
          const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
          if (!remaining) expire();
          else options.onTick(remaining);
        }
      })
      .catch(() => {
        if (stopped) return;
        unavailable = true;
        options.onUnavailable?.();
      })
      .finally(() => {
        checking = false;
      });
  };
  tick();
  if (!stopped) timer = window.setInterval(tick, 1000);
  return stop;
}

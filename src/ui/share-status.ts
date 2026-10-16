/** 合并状态查询；停止后或替换面板后，旧查询不得回写 UI。 */
export function watchShareStatus(options: {
  seconds: number;
  read: () => Promise<boolean>;
  onTick: (seconds: number) => void;
  onExpired: () => void;
}) {
  const deadline = Date.now() + options.seconds * 1000;
  let stopped = false,
    checking = false;
  let timer: number | undefined;
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
    options.onTick(remaining);
    if (!remaining) {
      expire();
      return;
    }
    if (checking) return;
    checking = true;
    void options
      .read()
      .then((active) => {
        if (!active) expire();
      })
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  };
  tick();
  if (!stopped) timer = window.setInterval(tick, 1000);
  return stop;
}

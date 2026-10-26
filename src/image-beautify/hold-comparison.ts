/** Momentary comparison supports pointer capture and keyboard, and always releases on cancellation. */
export function bindHoldComparison(options: {
  button: HTMLButtonElement;
  canStart: () => boolean;
  onChange: (active: boolean) => void;
}) {
  const { button } = options;
  let active = false,
    pointer: number | null = null,
    key = "";
  const stop = () => {
    const captured = pointer;
    pointer = null;
    key = "";
    if (active) {
      active = false;
      button.setAttribute("aria-pressed", "false");
      options.onChange(false);
    }
    if (captured !== null && button.hasPointerCapture(captured))
      button.releasePointerCapture(captured);
  };
  const start = () => {
    if (active || !options.canStart()) return;
    active = true;
    button.setAttribute("aria-pressed", "true");
    options.onChange(true);
  };
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !options.canStart()) return;
    event.preventDefault();
    pointer = event.pointerId;
    button.setPointerCapture(pointer);
    start();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const)
    button.addEventListener(type, (event) => {
      if (event.pointerId === pointer) stop();
    });
  button.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      key = event.key;
      start();
    }
  });
  button.addEventListener("keyup", (event) => {
    if (event.key !== key) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
  });
  button.addEventListener("blur", stop);
  window.addEventListener("blur", stop);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
  });
  return { stop, isActive: () => active };
}

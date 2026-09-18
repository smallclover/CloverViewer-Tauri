export type ToastKind = "success" | "error" | "info";

const visibilityTimers = new WeakMap<HTMLElement, number>();

/** Keeps overlay transitions reliable even when the user reduces motion. */
export function setAnimatedVisibility(el: HTMLElement, visible: boolean, duration = 180) {
  const previousTimer = visibilityTimers.get(el);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);

  if (visible) {
    el.classList.remove("hidden");
    requestAnimationFrame(() => el.classList.add("is-visible"));
    return;
  }

  el.classList.remove("is-visible");
  visibilityTimers.set(
    el,
    window.setTimeout(() => {
      if (!el.classList.contains("is-visible")) el.classList.add("hidden");
    }, duration),
  );
}

export function playEnterAnimation(el: HTMLElement, className = "view-enter") {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  window.setTimeout(() => el.classList.remove(className), 240);
}

export function createToast(toastEl: HTMLElement) {
  let toastTimer: number | undefined;

  return (message: string, kind: ToastKind = "info") => {
    toastEl.textContent = "";
    const icon = kind === "success" ? "✓" : kind === "error" ? "✕" : "";
    if (icon) {
      const iconElement = document.createElement("span");
      iconElement.className = `toast-ic ${kind}`;
      iconElement.textContent = icon;
      toastEl.appendChild(iconElement);
    }
    toastEl.appendChild(document.createTextNode(message));
    toastEl.classList.remove("hidden", "show");
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove("show");
      window.setTimeout(() => {
        if (!toastEl.classList.contains("show")) toastEl.classList.add("hidden");
      }, 180);
    }, 2200);
  };
}

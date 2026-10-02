export type ToastKind = "success" | "error" | "info" | "progress";

const visibilityTimers = new WeakMap<HTMLElement, number>();

/**
 * 不用 CSS 过渡，靠定时器切换 class，保证浮层淡入淡出可靠；
 * 系统开启「减少动态效果」时也照常生效。
 */
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
  let hideTimer: number | undefined;

  const hide = () => {
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastEl.classList.remove("show");
    hideTimer = window.setTimeout(() => {
      if (!toastEl.classList.contains("show")) toastEl.classList.add("hidden");
    }, 180);
  };
  const show = (message: string, kind: ToastKind = "info", persistent = false) => {
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    toastEl.textContent = "";
    toastEl.setAttribute("role", kind === "error" ? "alert" : "status");
    const icon = kind === "success" ? "✓" : kind === "error" ? "✕" : "";
    if (icon || kind === "progress") {
      const iconElement = document.createElement("span");
      iconElement.className = `toast-ic ${kind}`;
      iconElement.textContent = icon;
      toastEl.appendChild(iconElement);
    }
    toastEl.appendChild(document.createTextNode(message));
    toastEl.classList.remove("hidden", "show");
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    toastTimer = persistent ? undefined : window.setTimeout(hide, 2200);
  };
  show.hide = hide;
  return show;
}

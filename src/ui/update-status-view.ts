import { formatSize } from "../api";
import { APP_VERSION } from "../version";
import type { UpdateState } from "./update-controller";

const AUTO_DISMISS_MS = 5_000;

interface UpdateStatusViewOptions {
  checkButton: HTMLButtonElement;
  translate: (key: string, vars?: Record<string, string | number>) => string;
  onRetry: () => void;
  onDismiss: () => void;
  isBusy: () => boolean;
}
const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing update status element: ${id}`);
  return found as T;
};

/** 状态显示在设置面板之外的独立容器里，切走页面也不会把下载中的提示藏起来。 */
export function createUpdateStatusView(options: UpdateStatusViewOptions) {
  const panel = element("update-status");
  const message = element("update-status-message");
  const description = element("update-status-description");
  const icon = element("update-status-icon");
  const countdown = element("update-dismiss-countdown");
  const spinner = element("update-status-spinner");
  const progress = element<HTMLProgressElement>("update-progress");
  const details = element<HTMLDetailsElement>("update-error-details");
  const error = element("update-error-message");
  const retry = element<HTMLButtonElement>("update-retry");
  const dismiss = element<HTMLButtonElement>("update-dismiss");
  retry.addEventListener("click", options.onRetry);
  let dismissTimer: number | undefined;
  let dismissAt: number | undefined;
  const clearAutoDismiss = () => {
    window.clearTimeout(dismissTimer);
    dismissTimer = undefined;
    dismissAt = undefined;
  };
  dismiss.addEventListener("click", () => {
    clearAutoDismiss();
    options.onDismiss();
  });
  let state: UpdateState = { phase: "idle" };
  const updateCountdown = () => {
    if (dismissAt === undefined) return;
    const remaining = dismissAt - Date.now();
    if (remaining <= 0) {
      clearAutoDismiss();
      options.onDismiss();
      return;
    }
    countdown.textContent = options.translate("update.autoDismiss", {
      seconds: Math.ceil(remaining / 1000),
    });
    dismissTimer ??= window.setTimeout(
      () => {
        dismissTimer = undefined;
        updateCountdown();
      },
      Math.min(1000, remaining),
    );
  };
  const render = (next = state) => {
    state = next;
    const busy = options.isBusy();
    const phase = state.phase;
    const autoDismiss = phase === "latest" && !busy;
    if (!autoDismiss) clearAutoDismiss();
    const key =
      phase === "error"
        ? state.errorStage === "checking"
          ? state.networkError
            ? "update.networkUnavailable"
            : "update.failed"
          : state.errorStage === "downloading"
            ? state.networkError
              ? "update.downloadInterrupted"
              : "update.downloadFailed"
            : "update.installFailed"
        : phase === "downloading"
          ? state.percent === undefined
            ? "update.downloadingUnknown"
            : "update.downloading"
          : `update.${phase}`;
    panel.classList.toggle("hidden", phase === "idle" || phase === "available");
    panel.classList.toggle("error", phase === "error");
    options.checkButton.disabled = busy;
    options.checkButton.setAttribute("aria-busy", String(busy));
    options.checkButton.textContent = options.translate(
      phase === "checking" ? "settings.checkingUpdate" : "settings.checkUpdate",
    );
    if (phase === "idle" || phase === "available") return;
    message.setAttribute("role", phase === "error" ? "alert" : "status");
    message.textContent = options.translate(key, {
      percent: state.percent ?? 0,
      size: formatSize(state.downloaded ?? 0),
      attempt: state.attempt ?? 1,
      attempts: state.attempts ?? 3,
      msg: state.error ?? "",
    });
    description.hidden = phase !== "checking" && phase !== "latest";
    description.textContent = description.hidden
      ? ""
      : options.translate(
          phase === "checking" ? "update.checkingDescription" : "update.latestDescription",
          {
            version: APP_VERSION,
          },
        );
    icon.hidden = !["latest", "installed", "error"].includes(phase);
    icon.textContent = phase === "error" ? "!" : "✓";
    spinner.hidden = !busy || phase === "error" || phase === "latest";
    progress.hidden = !["downloading", "retrying", "verifying"].includes(phase);
    if (phase === "verifying") progress.value = 100;
    else if (state.percent !== undefined) progress.value = state.percent;
    else progress.removeAttribute("value");
    details.hidden = phase !== "error";
    error.textContent = state.error ?? "";
    if (phase !== "error") details.open = false;
    retry.hidden = phase !== "error";
    retry.disabled = busy;
    dismiss.hidden = busy;
    countdown.hidden = !autoDismiss;
    if (autoDismiss) {
      // 重绘和切换语言不重置倒计时；新检查或手动关闭会取消旧计时器。
      dismissAt ??= Date.now() + AUTO_DISMISS_MS;
      updateCountdown();
    }
  };
  return { render };
}

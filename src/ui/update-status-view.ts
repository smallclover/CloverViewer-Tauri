import { formatSize } from "../api";
import type { UpdateState } from "./update-controller";

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

/** Persistent feedback lives outside settings so navigating away cannot hide a download. */
export function createUpdateStatusView(options: UpdateStatusViewOptions) {
  const panel = element("update-status");
  const message = element("update-status-message");
  const spinner = element("update-status-spinner");
  const progress = element<HTMLProgressElement>("update-progress");
  const details = element<HTMLDetailsElement>("update-error-details");
  const error = element("update-error-message");
  const retry = element<HTMLButtonElement>("update-retry");
  const dismiss = element<HTMLButtonElement>("update-dismiss");
  retry.addEventListener("click", options.onRetry);
  dismiss.addEventListener("click", options.onDismiss);
  let state: UpdateState = { phase: "idle" };
  const render = (next = state) => {
    state = next;
    const busy = options.isBusy();
    const phase = state.phase;
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
  };
  return { render };
}

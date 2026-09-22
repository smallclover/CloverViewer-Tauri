import { t } from "../i18n";
import { makeBtn } from "./icons";

export interface LanSharePanel {
  show(
    info: { url: string; qr_code: string; expires_in_seconds: number; download_limit: number },
    position: (size: { w: number; h: number }) => { x: number; y: number },
  ): void;
  hide(): void;
}

/** Presents the single active LAN-share link and owns only its local countdown UI. */
export function createLanSharePanel({
  uiLayer,
  onCopy,
  onStop,
}: {
  uiLayer: HTMLElement;
  onCopy: (url: string) => Promise<void>;
  onStop: () => Promise<void>;
}): LanSharePanel {
  const element = document.createElement("section");
  element.id = "lan-share-panel";
  element.className = "ui-interactive";
  const title = document.createElement("strong");
  title.dataset.i18n = "shot.shareTitle";
  title.textContent = t("shot.shareTitle");
  const description = document.createElement("p");
  description.dataset.i18n = "shot.shareDescription";
  description.textContent = t("shot.shareDescription");
  const qr = document.createElement("img");
  qr.alt = t("shot.shareQrAlt");
  const url = document.createElement("code");
  const expires = document.createElement("span");
  expires.className = "lan-share-expires";
  const downloadRule = document.createElement("span");
  downloadRule.className = "lan-share-download-rule";
  const status = document.createElement("div");
  status.className = "lan-share-status";
  status.append(expires, downloadRule);
  const copy = makeBtn("copy", "shot.shareCopy");
  const stop = makeBtn("cancel", "shot.shareStop");
  const copyLabel = document.createElement("span");
  copyLabel.dataset.i18n = "shot.shareCopy";
  copyLabel.textContent = t("shot.shareCopy");
  copy.append(" ", copyLabel);
  const stopLabel = document.createElement("span");
  stopLabel.dataset.i18n = "shot.shareStop";
  stopLabel.textContent = t("shot.shareStop");
  stop.append(" ", stopLabel);
  const actions = document.createElement("div");
  actions.className = "lan-share-actions";
  actions.append(copy, stop);
  element.append(title, description, qr, url, status, actions);
  uiLayer.append(element);

  let timer: number | undefined;
  let feedbackTimer: number | undefined;
  let sharedUrl = "";
  const resetActions = () => {
    copy.disabled = false;
    copy.classList.remove("feedback", "error");
    copyLabel.textContent = t("shot.shareCopy");
    stop.disabled = false;
    stop.classList.remove("feedback");
    stopLabel.textContent = t("shot.shareStop");
  };
  const hide = () => {
    if (timer !== undefined) window.clearInterval(timer);
    if (feedbackTimer !== undefined) window.clearTimeout(feedbackTimer);
    timer = undefined;
    feedbackTimer = undefined;
    element.style.display = "none";
  };
  const updateCountdown = (deadline: number) => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const minutes = Math.floor(remaining / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (remaining % 60).toString().padStart(2, "0");
    expires.textContent = t("shot.shareExpires", { time: `${minutes}:${seconds}` });
    if (remaining === 0) hide();
  };
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    copy.disabled = true;
    void onCopy(sharedUrl)
      .then(() => {
        copy.classList.add("feedback");
        copyLabel.textContent = t("shot.shareCopied");
      })
      .catch(() => {
        copy.classList.add("error");
        copyLabel.textContent = t("shot.shareCopyFailed");
      })
      .finally(() => {
        feedbackTimer = window.setTimeout(() => {
          copy.disabled = false;
          copy.classList.remove("feedback", "error");
          copyLabel.textContent = t("shot.shareCopy");
        }, 1400);
      });
  });
  stop.addEventListener("click", (event) => {
    event.stopPropagation();
    stop.disabled = true;
    stop.classList.add("feedback");
    stopLabel.textContent = t("shot.shareStopped");
    void onStop().finally(() => {
      feedbackTimer = window.setTimeout(hide, 650);
    });
  });
  return {
    show(info, position) {
      hide();
      resetActions();
      sharedUrl = info.url;
      qr.src = info.qr_code;
      qr.alt = t("shot.shareQrAlt");
      url.textContent = info.url;
      downloadRule.textContent = t(
        info.download_limit === 1 ? "shot.shareDownloadsOnce" : "shot.shareDownloadsUnlimited",
      );
      element.style.display = "flex";
      const point = position({ w: element.offsetWidth, h: element.offsetHeight });
      element.style.left = `${Math.round(point.x)}px`;
      element.style.top = `${Math.round(point.y)}px`;
      const deadline = Date.now() + info.expires_in_seconds * 1000;
      updateCountdown(deadline);
      timer = window.setInterval(() => updateCountdown(deadline), 1000);
    },
    hide,
  };
}

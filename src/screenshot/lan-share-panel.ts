import { t } from "../i18n";
import { isLanShareActive, type LanShareInfo } from "../api";
import { watchShareStatus } from "../ui/share-status";
import { makeBtn } from "./icons";

export interface LanSharePanel {
  show(
    info: LanShareInfo,
    position: (size: { w: number; h: number }) => { x: number; y: number },
  ): void;
  hide(): void;
}

/** 查询分享的实际生效状态，倒计时仅用于展示剩余有效期。 */
export function createLanSharePanel({
  uiLayer,
  onCopy,
  onStop,
}: {
  uiLayer: HTMLElement;
  onCopy: (url: string) => Promise<void>;
  onStop: (shareId: string) => Promise<void>;
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
  expires.setAttribute("role", "status");
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

  let stopWatching: (() => void) | undefined;
  let feedbackTimer: number | undefined;
  let sharedUrl = "";
  let shareId = "";
  let generation = 0;
  let active = false;
  let stopping = false;
  const resetActions = () => {
    active = true;
    stopping = false;
    qr.hidden = false;
    url.hidden = downloadRule.hidden = false;
    copy.disabled = false;
    copy.classList.remove("feedback", "error");
    copyLabel.textContent = t("shot.shareCopy");
    stop.disabled = false;
    stop.classList.remove("feedback", "error");
    stopLabel.textContent = t("shot.shareStop");
  };
  const hide = () => {
    generation++;
    active = false;
    stopWatching?.();
    if (feedbackTimer !== undefined) window.clearTimeout(feedbackTimer);
    stopWatching = undefined;
    feedbackTimer = undefined;
    element.style.display = "none";
  };
  const updateCountdown = (remaining: number) => {
    const minutes = Math.floor(remaining / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (remaining % 60).toString().padStart(2, "0");
    expires.textContent = t("shot.shareExpires", { time: `${minutes}:${seconds}` });
  };
  const showEnded = () => {
    active = false;
    stopping = false;
    stopWatching?.();
    qr.hidden = url.hidden = downloadRule.hidden = true;
    copy.disabled = stop.disabled = true;
    copy.classList.remove("feedback", "error");
    copyLabel.textContent = t("shot.shareCopy");
    stop.classList.remove("feedback", "error");
    stopLabel.textContent = t("shot.shareStopped");
    expires.textContent = t("shot.shareExpired");
  };
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!active || stopping) return;
    const current = generation;
    copy.disabled = true;
    void onCopy(sharedUrl)
      .then(() => {
        if (current !== generation || !active || stopping) return;
        copy.classList.add("feedback");
        copyLabel.textContent = t("shot.shareCopied");
      })
      .catch(() => {
        if (current !== generation || !active || stopping) return;
        copy.classList.add("error");
        copyLabel.textContent = t("shot.shareCopyFailed");
      })
      .finally(() => {
        if (current !== generation || !active || stopping) return;
        feedbackTimer = window.setTimeout(() => {
          if (current !== generation || !active || stopping) return;
          copy.disabled = false;
          copy.classList.remove("feedback", "error");
          copyLabel.textContent = t("shot.shareCopy");
        }, 1400);
      });
  });
  stop.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!active || stopping) return;
    const current = generation;
    stopping = true;
    copy.disabled = true;
    stop.disabled = true;
    stop.classList.remove("error");
    stopLabel.textContent = t("shot.shareStopping");
    void onStop(shareId).then(
      () => {
        if (current === generation && active) showEnded();
      },
      () => {
        if (current !== generation || !active) return;
        stopping = false;
        copy.disabled = stop.disabled = false;
        stop.classList.add("error");
        stopLabel.textContent = t("shot.shareStopFailed");
      },
    );
  });
  return {
    show(info, position) {
      hide();
      resetActions();
      sharedUrl = info.url;
      shareId = info.share_id;
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
      stopWatching = watchShareStatus({
        seconds: info.expires_in_seconds,
        read: () => isLanShareActive(info.share_id),
        onTick: updateCountdown,
        onExpired: showEnded,
        onUnavailable: () => {
          expires.textContent = t("shot.shareStatusUnavailable");
        },
      });
    },
    hide,
  };
}

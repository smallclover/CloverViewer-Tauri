import type { ImageEntry, LanShareInfo } from "../api";
import { uiIcon } from "../ui/icons";
import { watchShareStatus } from "../ui/share-status";

interface ImageShareControllerOptions {
  panel: HTMLElement;
  startLanShare: (path: string) => Promise<LanShareInfo>;
  copyText: (text: string) => Promise<void>;
  stopLanShare: (shareId?: string) => Promise<void>;
  isLanShareActive: (shareId: string) => Promise<boolean>;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
}

/** 负责临时的局域网分享抽屉；关闭抽屉只会丢弃回调，不会中断已建立的链接。 */
export function createImageShareController(options: ImageShareControllerOptions) {
  let requestToken = 0;
  let stopWatching: (() => void) | undefined;

  const clearTimer = () => {
    stopWatching?.();
    stopWatching = undefined;
  };
  const header = () => {
    const row = document.createElement("header");
    row.className = "image-share-header";
    const title = document.createElement("h3");
    title.textContent = options.translate("prop.shareTitle");
    const close = document.createElement("button");
    close.className = "image-share-close";
    close.type = "button";
    close.innerHTML = uiIcon("close");
    close.title = options.translate("shot.close");
    close.setAttribute("aria-label", close.title);
    close.addEventListener("click", options.onClose);
    row.append(title, close);
    return row;
  };
  const retry = (entry: ImageEntry) => {
    const button = document.createElement("button");
    button.className = "image-share-retry";
    button.type = "button";
    button.textContent = options.translate("prop.share");
    button.addEventListener("click", () => open(entry));
    return button;
  };
  const showPending = (entry: ImageEntry) => {
    clearTimer();
    options.panel.replaceChildren(header());
    const text = document.createElement("p");
    text.className = "image-share-message";
    text.textContent = options.translate("prop.sharePreparing");
    options.panel.append(text);
    return entry;
  };
  const showError = (entry: ImageEntry, error: unknown) => {
    options.panel.replaceChildren(header());
    const text = document.createElement("p");
    text.className = "image-share-message error";
    text.textContent = options.translate("prop.shareFailed");
    text.title = String(error);
    options.panel.append(text, retry(entry));
  };
  const showShare = (entry: ImageEntry, info: LanShareInfo) => {
    const token = requestToken;
    let active = true,
      stopping = false;
    const current = () => token === requestToken && active;
    options.panel.replaceChildren();
    const name = document.createElement("div");
    name.className = "image-share-file";
    name.textContent = entry.name;
    name.title = entry.name;
    const hint = document.createElement("p");
    hint.className = "image-share-hint";
    hint.textContent = options.translate("prop.shareDescription");
    const qr = document.createElement("img");
    qr.className = "image-share-qr";
    qr.src = info.qr_code;
    qr.alt = options.translate("prop.shareQrAlt");
    const link = document.createElement("code");
    link.className = "image-share-link";
    link.textContent = info.url;
    link.title = info.url;
    const status = document.createElement("div");
    status.className = "image-share-status";
    const expires = document.createElement("span");
    expires.setAttribute("role", "status");
    const rule = document.createElement("span");
    rule.textContent = options.translate(
      info.download_limit === 1 ? "prop.shareDownloadsOnce" : "prop.shareDownloadsUnlimited",
    );
    status.append(expires, rule);
    const actions = document.createElement("div");
    actions.className = "image-share-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = options.translate("prop.shareCopy");
    const stop = document.createElement("button");
    stop.type = "button";
    stop.textContent = options.translate("prop.shareStop");
    actions.append(copy, stop);
    options.panel.append(header(), name, hint, qr, link, status, actions);

    const showEnded = () => {
      if (!current()) return;
      active = false;
      clearTimer();
      const message = document.createElement("p");
      message.className = "image-share-message";
      message.setAttribute("role", "status");
      message.textContent = options.translate("shot.shareExpired");
      options.panel.replaceChildren(header(), message, retry(entry));
    };
    stopWatching = watchShareStatus({
      seconds: info.expires_in_seconds,
      read: () => options.isLanShareActive(info.share_id),
      onTick: (seconds) => {
        const time = `${Math.floor(seconds / 60)
          .toString()
          .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
        expires.textContent = options.translate("prop.shareExpires", { time });
      },
      onExpired: showEnded,
      onUnavailable: () => {
        if (current()) expires.textContent = options.translate("shot.shareStatusUnavailable");
      },
    });
    copy.addEventListener("click", () => {
      if (!current() || stopping) return;
      copy.disabled = true;
      void options
        .copyText(info.url)
        .then(
          () => {
            if (!current() || stopping) return;
            copy.classList.add("feedback");
            copy.textContent = options.translate("prop.shareCopied");
          },
          () => {
            if (!current() || stopping) return;
            copy.classList.add("error");
            copy.textContent = options.translate("prop.shareCopyFailed");
          },
        )
        .finally(() =>
          window.setTimeout(() => {
            if (!current() || stopping) return;
            copy.disabled = false;
            copy.classList.remove("feedback", "error");
            copy.textContent = options.translate("prop.shareCopy");
          }, 1400),
        );
    });
    stop.addEventListener("click", () => {
      if (!current() || stopping) return;
      stopping = true;
      copy.disabled = true;
      stop.disabled = true;
      stop.classList.remove("error");
      stop.textContent = options.translate("shot.shareStopping");
      void options.stopLanShare(info.share_id).then(showEnded, () => {
        if (!current()) return;
        stopping = false;
        copy.disabled = stop.disabled = false;
        stop.classList.add("error");
        stop.textContent = options.translate("shot.shareStopFailed");
      });
    });
  };
  const open = (entry: ImageEntry) => {
    const current = ++requestToken;
    showPending(entry);
    void options.startLanShare(entry.path).then(
      (info) => {
        if (current === requestToken) showShare(entry, info);
      },
      (error) => {
        if (current === requestToken) showError(entry, error);
      },
    );
  };
  const close = () => {
    requestToken += 1;
    clearTimer();
  };
  return { open, close };
}

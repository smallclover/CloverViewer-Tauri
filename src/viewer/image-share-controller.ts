import type { ImageEntry, LanShareInfo } from "../api";

interface ImageShareControllerOptions {
  panel: HTMLElement;
  startLanShare: (path: string) => Promise<LanShareInfo>;
  copyText: (text: string) => Promise<void>;
  stopLanShare: () => Promise<void>;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
}

/** Owns the temporary LAN-share drawer; closing it never stops an active link. */
export function createImageShareController(options: ImageShareControllerOptions) {
  let requestToken = 0;
  let timer: number | undefined;

  const clearTimer = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };
  const header = () => {
    const row = document.createElement("header");
    row.className = "image-share-header";
    const title = document.createElement("h3");
    title.textContent = options.translate("prop.shareTitle");
    const close = document.createElement("button");
    close.className = "image-share-close";
    close.type = "button";
    close.textContent = "×";
    close.title = options.translate("shot.close");
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

    const deadline = Date.now() + info.expires_in_seconds * 1000;
    const updateCountdown = () => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const time = `${Math.floor(seconds / 60)
        .toString()
        .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
      expires.textContent = options.translate("prop.shareExpires", { time });
      if (seconds === 0) {
        clearTimer();
        options.panel.replaceChildren(header(), retry(entry));
      }
    };
    updateCountdown();
    timer = window.setInterval(updateCountdown, 1000);
    copy.addEventListener("click", () => {
      copy.disabled = true;
      void options
        .copyText(info.url)
        .then(
          () => {
            copy.classList.add("feedback");
            copy.textContent = options.translate("prop.shareCopied");
          },
          () => {
            copy.classList.add("error");
            copy.textContent = options.translate("prop.shareCopyFailed");
          },
        )
        .finally(() =>
          window.setTimeout(() => {
            copy.disabled = false;
            copy.classList.remove("feedback", "error");
            copy.textContent = options.translate("prop.shareCopy");
          }, 1400),
        );
    });
    stop.addEventListener("click", () => {
      stop.disabled = true;
      stop.classList.add("feedback");
      stop.textContent = options.translate("prop.shareStopped");
      void options.stopLanShare().finally(() => {
        window.setTimeout(() => {
          clearTimer();
          options.panel.replaceChildren(header(), retry(entry));
        }, 650);
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

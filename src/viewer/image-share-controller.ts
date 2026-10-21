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

const SHARE_STATES = {
  pending: { title: "prop.sharePreparing", hint: "prop.sharePreparingHint", icon: "refresh" },
  expired: { title: "prop.shareExpired", hint: "prop.shareExpiredHint", icon: "linkOff" },
  failed: { title: "prop.shareFailed", hint: "prop.shareFailedHint", icon: "alert" },
} as const;

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
    row.className = "image-share-header floating-share-heading";
    const title = document.createElement("h3");
    title.className = "floating-title";
    title.textContent = options.translate("prop.shareTitle");
    const close = document.createElement("button");
    close.className = "image-share-close floating-close";
    close.type = "button";
    close.innerHTML = uiIcon("close");
    close.title = options.translate("shot.close");
    close.setAttribute("aria-label", close.title);
    close.addEventListener("click", options.onClose);
    row.append(title, close);
    return row;
  };
  const showState = (entry: ImageEntry, phase: keyof typeof SHARE_STATES, error?: unknown) => {
    const state = SHARE_STATES[phase];
    const body = document.createElement("div");
    body.className = `floating-empty image-share-empty ${phase}`;
    const icon = document.createElement("span");
    icon.className = "floating-empty-icon";
    icon.innerHTML = uiIcon(state.icon);
    icon.ariaHidden = "true";
    const copy = document.createElement("div");
    copy.className = "floating-empty-copy";
    copy.setAttribute("role", phase === "failed" ? "alert" : "status");
    const title = document.createElement("h3");
    title.className = "floating-title";
    title.textContent = options.translate(state.title);
    const hint = document.createElement("p");
    hint.className = "floating-hint";
    hint.textContent = options.translate(state.hint);
    if (error !== undefined) hint.title = String(error);
    copy.append(title, hint);
    const button = document.createElement("button");
    button.className = "floating-action primary";
    button.type = "button";
    button.disabled = phase === "pending";
    const buttonIcon = document.createElement("span");
    buttonIcon.innerHTML = uiIcon("refresh");
    const label = document.createElement("span");
    label.textContent = options.translate(
      phase === "pending"
        ? "prop.shareGenerating"
        : phase === "expired"
          ? "prop.shareAgain"
          : "prop.shareRetry",
    );
    button.append(buttonIcon, label);
    if (phase !== "pending") button.addEventListener("click", () => open(entry));
    const actions = document.createElement("div");
    actions.className = "floating-actions";
    actions.append(button);
    body.append(icon, copy, actions);
    options.panel.replaceChildren(header(), body);
  };
  const showShare = (entry: ImageEntry, info: LanShareInfo) => {
    const token = requestToken;
    let active = true,
      stopping = false;
    const current = () => token === requestToken && active;
    options.panel.replaceChildren();
    const body = document.createElement("div");
    body.className = "floating-share-body";
    const content = document.createElement("div");
    content.className = "floating-share-stack";
    const name = document.createElement("div");
    name.className = "image-share-file";
    name.textContent = entry.name;
    name.title = entry.name;
    const hint = document.createElement("p");
    hint.className = "image-share-hint floating-share-description";
    hint.textContent = options.translate("prop.shareDescription");
    const qr = document.createElement("img");
    qr.className = "image-share-qr";
    qr.src = info.qr_code;
    qr.alt = options.translate("prop.shareQrAlt");
    const link = document.createElement("code");
    link.className = "image-share-link floating-share-link";
    link.textContent = info.url;
    link.title = info.url;
    const status = document.createElement("div");
    status.className = "image-share-status floating-share-status";
    const expires = document.createElement("span");
    expires.setAttribute("role", "status");
    const rule = document.createElement("span");
    rule.textContent = options.translate(
      info.download_limit === 1 ? "prop.shareDownloadsOnce" : "prop.shareDownloadsUnlimited",
    );
    status.append(expires, rule);
    const actions = document.createElement("div");
    actions.className = "image-share-actions floating-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "floating-action primary";
    const copyIcon = document.createElement("span");
    copyIcon.innerHTML = uiIcon("copy");
    const copyLabel = document.createElement("span");
    copyLabel.textContent = options.translate("prop.shareCopy");
    copy.append(copyIcon, copyLabel);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "floating-action";
    stop.textContent = options.translate("prop.shareStop");
    actions.append(stop, copy);
    content.append(name, hint, qr, link, status, actions);
    body.append(content);
    options.panel.append(header(), body);

    const showEnded = () => {
      if (!current()) return;
      active = false;
      clearTimer();
      showState(entry, "expired");
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
            copyLabel.textContent = options.translate("prop.shareCopied");
          },
          () => {
            if (!current() || stopping) return;
            copy.classList.add("error");
            copyLabel.textContent = options.translate("prop.shareCopyFailed");
          },
        )
        .finally(() =>
          window.setTimeout(() => {
            if (!current() || stopping) return;
            copy.disabled = false;
            copy.classList.remove("feedback", "error");
            copyLabel.textContent = options.translate("prop.shareCopy");
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
    clearTimer();
    showState(entry, "pending");
    void options.startLanShare(entry.path).then(
      (info) => {
        if (current === requestToken) showShare(entry, info);
      },
      (error) => {
        if (current === requestToken) showState(entry, "failed", error);
      },
    );
  };
  const close = () => {
    requestToken += 1;
    clearTimer();
  };
  return { open, close };
}

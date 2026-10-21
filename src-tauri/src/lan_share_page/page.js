(() => {
  "use strict";
  const dictionaries = JSON.parse(document.getElementById("translations").textContent);
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
  const language = preferred.map(tag => tag.toLowerCase().split("-")[0])
    .find(tag => tag === "zh" || tag === "en" || tag === "ja") || "en";
  const locale = language === "zh" ? "zh-CN" : language;
  const text = dictionaries[locale];
  const byId = id => document.getElementById(id);
  const image = byId("shared-image");
  const feedback = byId("feedback");
  const linkPanel = byId("link-panel");
  const linkInput = byId("share-link");
  const data = document.body.dataset;
  const baseUrl = new URL(location.href);
  baseUrl.search = "";
  baseUrl.hash = "";
  const shareUrl = baseUrl.href;
  const statusUrl = new URL(`${baseUrl.pathname.replace(/\/$/, "")}/status`, baseUrl.origin).href;
  let remaining = Number(data.remaining);
  let deadline = Date.now() + Number(data.seconds) * 1000;
  let state = Number(data.seconds) > 0 ? "active" : "expired";
  let polling = false;
  let retryImage = false;
  let checkSequence = 0;
  document.documentElement.lang = locale;
  document.title = `CloverViewer · ${text.title}`;
  document.querySelectorAll("[data-text]").forEach(element => {
    element.textContent = text[element.dataset.text];
  });
  image.alt = text.imageAlt;
  byId("preview-link").ariaLabel = text.view;
  linkInput.value = shareUrl;
  byId("wechat-hint").hidden = !/MicroMessenger/i.test(navigator.userAgent);

  function metadata() {
    const bytes = Number(data.bytes);
    const size = bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toLocaleString(locale, {maximumFractionDigits: 1})} MB`
      : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
    const format = data.mime === "image/jpeg" ? "JPEG" : "PNG";
    const dimensions = image.naturalWidth > 0 ? `${image.naturalWidth} × ${image.naturalHeight}` : "";
    byId("file-meta").textContent = [format, dimensions, size].filter(Boolean).join(" · ");
  }

  function render() {
    const active = state === "active";
    byId("file-content").hidden = !active;
    byId("unavailable").hidden = active;
    byId("retry-button").hidden = state === "expired";
    if (!active) {
      const prefix = state === "offline" ? "offline" : state === "image-error" ? "loading" : "expired";
      byId("state-title").textContent = text[`${prefix}Title`];
      byId("state-hint").textContent = text[`${prefix}Hint`];
      linkPanel.hidden = true;
      feedback.textContent = "";
    }
    byId("download-limit").textContent = remaining === -1 ? text.unlimited : text.once;
  }

  function tick() {
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (seconds === 0 && state !== "expired") {
      state = "expired";
      checkSequence++;
      render();
    }
    const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    byId("countdown").textContent = text.expires.replace("{time}", time);
  }

  async function checkStatus() {
    if (polling || state === "expired" || document.hidden) return;
    polling = true;
    const sequence = ++checkSequence;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(statusUrl, {cache: "no-store", signal: controller.signal});
      if (!response.ok) throw new Error("Unavailable");
      const result = await response.json();
      if (sequence !== checkSequence) return;
      if (!result.active || result.expires_in_seconds <= 0) {
        state = "expired";
      } else {
        deadline = Date.now() + result.expires_in_seconds * 1000;
        remaining = result.downloads_remaining == null ? -1 : result.downloads_remaining;
        state = retryImage ? "image-error" : "active";
      }
    } catch {
      if (sequence === checkSequence) state = "offline";
    } finally {
      clearTimeout(timeout);
      polling = false;
      render();
      tick();
    }
  }

  function selectLink() {
    linkInput.focus();
    linkInput.select();
    linkInput.setSelectionRange(0, linkInput.value.length);
  }

  async function copyLink() {
    if (state !== "active") return;
    linkPanel.hidden = false;
    selectLink();
    let copied = false;
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      } catch { /* Manual copying remains available. */ }
    }
    if (!copied) {
      try { copied = document.execCommand("copy"); } catch { /* Keep selection for manual copying. */ }
    }
    if (state === "active") feedback.textContent = copied ? text.copied : text.manualCopy;
  }

  byId("share-button").addEventListener("click", async () => {
    if (state !== "active") return;
    if (window.isSecureContext && typeof navigator.share === "function") {
      try {
        await navigator.share({title: data.filename || text.title, url: shareUrl});
        if (state === "active") feedback.textContent = text.shared;
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    await copyLink();
  });
  byId("copy-button").addEventListener("click", copyLink);
  linkInput.addEventListener("click", selectLink);
  byId("download-button").addEventListener("click", () => setTimeout(checkStatus, 700));
  byId("retry-button").addEventListener("click", () => {
    if (retryImage) {
      const url = new URL(image.src);
      url.searchParams.set("retry", String(Date.now()));
      image.src = url.href;
    }
    checkStatus();
  });
  image.addEventListener("load", () => {
    metadata();
    if (retryImage) {
      retryImage = false;
      checkStatus();
    }
  });
  image.addEventListener("error", () => {
    if (state === "expired") return;
    retryImage = true;
    state = "image-error";
    render();
    checkStatus();
  });
  document.addEventListener("visibilitychange", () => {
    tick();
    if (!document.hidden) checkStatus();
  });
  window.addEventListener("pageshow", () => {tick(); checkStatus();});
  metadata();
  render();
  tick();
  if (image.complete && image.naturalWidth === 0 && state === "active") {
    retryImage = true;
    state = "image-error";
    render();
  }
  setInterval(tick, 1000);
  setInterval(checkStatus, 15000);
})();

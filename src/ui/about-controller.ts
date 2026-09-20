import { getAppInfo, openUrl } from "../api";
import { APP_VERSION } from "../version";
import { setAnimatedVisibility, type ToastKind } from "./presentation";

const aboutLinks: Array<[string, string]> = [
  ["about-link-repo", "https://github.com/smallclover/CloverViewer-Tauri"],
  ["about-link-releases", "https://github.com/smallclover/CloverViewer-Tauri/releases"],
  ["about-link-original", "https://github.com/smallclover/CloverViewer"],
  ["about-link-license", "https://github.com/smallclover/CloverViewer-Tauri/blob/main/LICENSE"],
];

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing about element: ${id}`);
  return found as T;
};

/** Owns the About overlay, runtime metadata, and its external links. */
export function createAboutController(options: {
  toast: (message: string, kind?: ToastKind) => void;
}) {
  const overlay = element("about-overlay");
  const version = element("about-version");
  const infoVersion = element("info-version");
  const identifier = element("info-identifier");
  const ui = element("info-ui");
  const runtime = element("info-runtime");
  let loaded = false;

  const fillInfo = async () => {
    version.textContent = `v${APP_VERSION}`;
    infoVersion.textContent = APP_VERSION;
    try {
      const info = await getAppInfo();
      version.textContent = `v${info.version}`;
      infoVersion.textContent = info.version;
      identifier.textContent = info.identifier;
      const parts = [`Tauri ${info.tauri}`];
      const edge = /Edg\/(\d+)/.exec(navigator.userAgent);
      if (edge) parts.push(`WebView2 ${edge[1]}`);
      ui.textContent = parts.join(" · ");
      const os = info.os === "windows" ? "Windows" : info.os;
      const arch = info.arch === "x86_64" ? "x64" : info.arch;
      runtime.textContent = `${os} · ${arch}`;
    } catch {
      // The build-time version remains useful when the backend is unavailable.
    }
  };
  const open = () => {
    setAnimatedVisibility(overlay, true, 220);
    if (!loaded) {
      loaded = true;
      void fillInfo();
    }
  };
  const close = () => setAnimatedVisibility(overlay, false, 220);

  element("btn-about").addEventListener("click", open);
  element("about-close").addEventListener("click", close);
  for (const [id, url] of aboutLinks) {
    element(id).addEventListener("click", (event) => {
      event.preventDefault();
      void openUrl(url).catch((error) => options.toast(String(error), "error"));
    });
  }

  return {
    isOpen: () => !overlay.classList.contains("hidden"),
    closeIfOpen: () => {
      if (overlay.classList.contains("hidden")) return false;
      close();
      return true;
    },
  };
}

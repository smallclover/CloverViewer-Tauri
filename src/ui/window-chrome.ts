import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n";

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing window chrome element: ${id}`);
  return found as T;
};

/** Binds custom titlebar controls to the native window drag and resize APIs. */
export function bindWindowChrome() {
  const windowHandle = getCurrentWindow();
  element("win-min").addEventListener("click", () => void windowHandle.minimize());
  element("win-close").addEventListener("click", () => void windowHandle.close());
  const maximize = element<HTMLButtonElement>("win-max");
  let stateRevision = 0;
  const syncMaximized = async () => {
    const revision = ++stateRevision;
    try {
      const maximized = await windowHandle.isMaximized();
      if (revision !== stateRevision) return;
      maximize.dataset.maximized = String(maximized);
      document.documentElement.dataset.windowMaximized = String(maximized);
      const label = maximized ? "win.restore" : "win.max";
      maximize.dataset.i18nTitle = label;
      maximize.dataset.i18nAriaLabel = label;
      maximize.title = t(label);
      maximize.ariaLabel = t(label);
    } catch (error) {
      console.error("Reading maximized window state failed", error);
    }
  };
  maximize.addEventListener("click", async () => {
    if (maximize.disabled) return;
    maximize.disabled = true;
    try {
      await windowHandle.toggleMaximize();
      await syncMaximized();
    } catch (error) {
      console.error("Toggling window maximize failed", error);
    } finally {
      maximize.disabled = false;
    }
  });
  void windowHandle
    .onResized(() => void syncMaximized())
    .then(() => syncMaximized())
    .catch((error) => console.error("Listening for window resize failed", error));
  const titlebar = element("titlebar");
  titlebar.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".titlebar-controls, #toolbar, .page-navigation")) {
      return;
    }
    void windowHandle.startDragging();
  });
  document.querySelectorAll<HTMLElement>(".resize-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const direction = handle.dataset.dir;
      if (
        direction === "East" ||
        direction === "West" ||
        direction === "South" ||
        direction === "SouthEast" ||
        direction === "SouthWest"
      ) {
        void windowHandle.startResizeDragging(direction);
      }
    });
  });
}

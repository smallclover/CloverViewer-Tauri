import { getCurrentWindow } from "@tauri-apps/api/window";

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
  const titlebar = element("titlebar");
  titlebar.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".titlebar-controls, #toolbar")) return;
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

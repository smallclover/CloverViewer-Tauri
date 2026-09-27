import "./desktop-pet.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getConfig, getDesktopPetCursorPosition } from "./api";
import { applyI18n, setLang } from "./i18n";
import { Live2DPetRenderer } from "./pet/live2d-renderer";

const pet = document.getElementById("pet") as HTMLElement;
const live2dHost = document.getElementById("pet-live2d") as HTMLElement;
const renderer = new Live2DPetRenderer();
const isTauriWindow = "__TAURI_INTERNALS__" in window;
const desktopWindow = isTauriWindow ? getCurrentWindow() : undefined;

function celebrate() {
  pet.classList.remove("is-celebrating");
  window.requestAnimationFrame(() => pet.classList.add("is-celebrating"));
  window.setTimeout(() => pet.classList.remove("is-celebrating"), 1_250);
  void renderer.celebrate();
}

// A plain browser preview has no Tauri IPC bridge; keep the default locale and
// animation there while the production window receives its real IPC events.
if (desktopWindow) {
  pet.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;

    pet.classList.add("is-dragging");
    void desktopWindow.startDragging().catch(() => undefined);
  });
  window.addEventListener("mouseup", () => pet.classList.remove("is-dragging"));

  void getConfig()
    .then((config) => {
      setLang(config.language);
      applyI18n();
    })
    .catch(() => undefined);
  void listen("desktop-pet-celebrate", celebrate).catch(() => undefined);

  let cursorRequestInFlight = false;
  const updateGaze = async () => {
    if (cursorRequestInFlight) return;
    cursorRequestInFlight = true;
    try {
      const [cursor, petPosition] = await Promise.all([
        getDesktopPetCursorPosition(),
        desktopWindow.outerPosition(),
      ]);
      if (!cursor) {
        renderer.setGazeTarget(undefined);
        return;
      }
      const density = window.devicePixelRatio || 1;
      renderer.setGazeTarget({
        x: cursor.x - petPosition.x - (window.innerWidth * density) / 2,
        y: cursor.y - petPosition.y - (window.innerHeight * density) / 2,
      });
    } catch {
      renderer.setGazeTarget(undefined);
    } finally {
      cursorRequestInFlight = false;
    }
  };
  void updateGaze();
  window.setInterval(() => void updateGaze(), 100);
}

void renderer
  .mount(live2dHost)
  .then((isLive2D) => {
    if (!isLive2D) return;
    pet.classList.add("is-live2d");
    // Rust starts this transparent window in click-through mode. Turn input on
    // only once a visible character is ready, so a failed model can never block
    // clicks and drags in the viewer below it.
    void desktopWindow?.setIgnoreCursorEvents(false).catch(() => undefined);
    window.requestAnimationFrame(() => renderer.refreshLayout());
  })
  .catch(() => renderer.destroy());

document.addEventListener("visibilitychange", () => {
  renderer.setPaused(document.hidden);
});
window.addEventListener("beforeunload", () => {
  renderer.destroy();
});

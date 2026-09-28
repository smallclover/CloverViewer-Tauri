import "./desktop-pet.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getConfig,
  getDesktopPetCursorPosition,
  listenDesktopPetStatusRequest,
  reportDesktopPetLoadStatus,
} from "./api";
import { applyI18n, setLang } from "./i18n";
import { Live2DPetRenderer } from "./pet/live2d-renderer";

const pet = document.getElementById("pet") as HTMLElement;
const live2dHost = document.getElementById("pet-live2d") as HTMLElement;
const isTauriWindow = "__TAURI_INTERNALS__" in window;
const desktopWindow = isTauriWindow ? getCurrentWindow() : undefined;
const sessionId = crypto.randomUUID();
let loadFinished = false;
let loadFailed = false;

const reportLoadStatus = (state: "started" | "ready" | "failed") => {
  return desktopWindow
    ? reportDesktopPetLoadStatus({ state, sessionId }).catch(() => undefined)
    : Promise.resolve();
};

const failLoad = () => {
  if (loadFailed) return;
  loadFailed = true;
  loadFinished = true;
  // Closing a failed secondary window permits a later off/on retry to create it afresh.
  void reportLoadStatus("failed").finally(() => {
    void desktopWindow?.close().catch(() => undefined);
  });
};

const renderer = new Live2DPetRenderer(() => {
  if (loadFinished) return;
  loadFinished = true;
  pet.classList.add("is-ready");
  void desktopWindow?.setIgnoreCursorEvents(false).catch(() => undefined);
  void reportLoadStatus("ready");
}, failLoad);

function celebrate() {
  pet.classList.remove("is-celebrating");
  window.requestAnimationFrame(() => pet.classList.add("is-celebrating"));
  window.setTimeout(() => pet.classList.remove("is-celebrating"), 1_250);
  void renderer.celebrate();
}

// A plain browser preview has no Tauri IPC bridge; keep the default locale and
// animation there while the production window receives its real IPC events.
if (desktopWindow) {
  void listenDesktopPetStatusRequest(() => {
    void reportLoadStatus("started").then(() => {
      if (loadFailed) return reportLoadStatus("failed");
      if (loadFinished) return reportLoadStatus("ready");
    });
  }).catch(() => undefined);

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

const initialStatus = reportLoadStatus("started");
// Let the small loading bubble paint before parsing the Cubism core and texture.
window.setTimeout(() => {
  void initialStatus
    .then(() => renderer.mount(live2dHost))
    .then((isLive2D) => {
      if (!isLive2D) {
        failLoad();
        return;
      }
      pet.classList.add("is-live2d");
      window.requestAnimationFrame(() => renderer.refreshLayout());
    })
    .catch(() => {
      renderer.destroy();
      failLoad();
    });
}, 80);

document.addEventListener("visibilitychange", () => {
  renderer.setPaused(document.hidden);
});
window.addEventListener("beforeunload", () => {
  renderer.destroy();
});

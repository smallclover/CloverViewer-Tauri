import "./desktop-pet.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getConfig,
  getDesktopPetCursorPosition,
  listenDesktopPetStatusRequest,
  reportDesktopPetLoadStatus,
  showDesktopPetMenu,
} from "./api";
import { applyI18n, getLang, setLang, t } from "./i18n";
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
  // 关闭加载失败的独立窗口，后续 off/on 重试才能重新创建它。
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

// 纯浏览器预览没有 Tauri IPC 桥，保持默认语言与动画；
// 正式窗口则由真实的 IPC 事件驱动。
if (desktopWindow) {
  let contextMenuOpening = false;

  const showContextMenu = async (x: number, y: number) => {
    const config = await getConfig().catch(() => undefined);
    if (config && config.language !== getLang()) {
      setLang(config.language);
      applyI18n();
    }
    await showDesktopPetMenu(
      {
        screenshot: t("pet.menu.screenshot"),
        scrollScreenshot: t("pet.menu.scrollScreenshot"),
        mainWindow: t("pet.menu.mainWindow"),
        quit: t("pet.menu.quit"),
      },
      x,
      y,
    );
  };

  pet.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (contextMenuOpening) return;
    contextMenuOpening = true;
    void showContextMenu(event.clientX, event.clientY)
      .catch((error) => console.error("桌宠菜单无法打开", error))
      .finally(() => {
        contextMenuOpening = false;
      });
  });

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
// 先让加载气泡绘制出来，再去解析 Cubism 核心与贴图。
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

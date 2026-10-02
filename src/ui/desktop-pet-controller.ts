import {
  type AppConfig,
  type DesktopPetLoadStatus,
  listenDesktopPetLoadStatus,
  requestDesktopPetLoadStatus,
  setDesktopPetEnabled,
} from "../api";
import type { ToastKind } from "./presentation";

interface DesktopPetControllerOptions {
  status: HTMLElement;
  statusText: HTMLElement;
  getConfig: () => AppConfig | null;
  setCurrentConfig: (config: AppConfig) => void;
  translate: (key: string, vars?: Record<string, string | number>) => string;
  toast: (message: string, kind?: ToastKind) => void;
}

/** 在独立的 Live2D 窗口启动期间保持主窗口可响应。 */
export function createDesktopPetController(options: DesktopPetControllerOptions) {
  let ready = false;
  let wanted = false;
  let requestId = 0;
  let activeSessionId: string | undefined;
  let slowTimer: number | undefined;
  let longTimer: number | undefined;
  let timeoutTimer: number | undefined;

  const setStatusText = (key: string) => {
    options.statusText.dataset.i18n = key;
    options.statusText.textContent = options.translate(key);
  };

  const clearStatus = () => {
    window.clearTimeout(slowTimer);
    window.clearTimeout(longTimer);
    window.clearTimeout(timeoutTimer);
    options.status.classList.add("hidden");
  };

  const showLoading = () => {
    clearStatus();
    setStatusText("pet.loading");
    options.status.classList.remove("hidden");
    slowTimer = window.setTimeout(() => setStatusText("pet.loadingSlow"), 12_000);
    longTimer = window.setTimeout(() => setStatusText("pet.loadingLong"), 30_000);
    timeoutTimer = window.setTimeout(() => {
      if (!wanted || ready) return;
      options.toast(options.translate("toast.desktopPetTimedOut"), "error");
      void setEnabled(false, true).catch((error) => {
        options.toast(options.translate("toast.desktopPetFailed", { msg: String(error) }), "error");
      });
    }, 90_000);
  };

  const onLoadStatus = (status: DesktopPetLoadStatus) => {
    if (status.state === "started") {
      if (activeSessionId !== status.sessionId) {
        activeSessionId = status.sessionId;
        ready = false;
        if (wanted && options.status.classList.contains("hidden")) showLoading();
      }
      return;
    }
    if (status.sessionId !== activeSessionId) return;
    if (status.state === "ready") {
      const wasReady = ready;
      ready = true;
      clearStatus();
      if (wanted && !wasReady) options.toast(options.translate("toast.desktopPetOn"), "success");
    } else {
      ready = false;
      clearStatus();
      if (wanted) options.toast(options.translate("toast.desktopPetLoadFailed"), "error");
    }
  };

  // 必须先于任何创建桌宠窗口的请求完成订阅，否则其首帧事件
  // 会与主窗口注册监听的时机产生竞态。
  const listener = listenDesktopPetLoadStatus(onLoadStatus);
  void listener.catch(() => undefined);

  const setEnabled = (enabled: boolean, quiet = false): Promise<void> => {
    wanted = enabled;
    const id = ++requestId;
    const wasReady = ready;
    const previousEnabled = options.getConfig()?.desktop_pet_enabled ?? false;
    const config = options.getConfig();
    if (config) options.setCurrentConfig({ ...config, desktop_pet_enabled: enabled });
    if (enabled && !ready) showLoading();
    if (!enabled) clearStatus();

    const next = (async () => {
      await listener;
      if (enabled && !wasReady) {
        // 先给状态卡片一点绘制时间，再创建原生 WebView。
        await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
      }
      if (id !== requestId) return;
      await setDesktopPetEnabled(enabled);
      if (enabled && !wasReady) void requestDesktopPetLoadStatus().catch(() => undefined);
      if (id !== requestId) return;
      if (!quiet) {
        if (!enabled) options.toast(options.translate("toast.desktopPetOff"), "success");
        else if (wasReady) options.toast(options.translate("toast.desktopPetOn"), "success");
      }
    })();
    return next.catch((error) => {
      if (id !== requestId) return;
      wanted = !enabled;
      clearStatus();
      const current = options.getConfig();
      if (current) {
        options.setCurrentConfig({ ...current, desktop_pet_enabled: previousEnabled });
      }
      throw error;
    });
  };

  return { setEnabled };
}

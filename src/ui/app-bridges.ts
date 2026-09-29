import { getCurrentWindow } from "@tauri-apps/api/window";
import { listenOpenImage, takeStartupNotices, type OpenImagePayload } from "../api";
import { setAnimatedVisibility, type ToastKind } from "./presentation";

type Toast = (message: string, kind?: ToastKind, persistent?: boolean) => void;
type ProgressToast = Toast & { hide: () => void };
type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Binds Tauri drag/drop payloads to the main viewer's file-opening flow. */
export function bindFileDrop(
  overlay: HTMLElement,
  openPath: (path: string) => Promise<void>,
): void {
  void getCurrentWindow().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "enter" || payload.type === "over") {
      setAnimatedVisibility(overlay, true);
      return;
    }
    setAnimatedVisibility(overlay, false);
    if (payload.type === "drop" && payload.paths.length > 0) {
      void openPath(payload.paths[0]);
    }
  });
}

/** Opens a screenshot that the backend has materialized as a temporary image file. */
export async function bindOpenImageBridge(
  openPath: (payload: OpenImagePayload) => Promise<void>,
  translate: Translate,
  toast: ProgressToast,
): Promise<void> {
  await listenOpenImage(async (payload) => {
    if (!payload?.path) return;
    const isOcr = payload.ocr_text !== undefined;
    if (isOcr) toast(translate("toast.openingOcr"), "progress", true);
    try {
      await openPath(payload);
      if (isOcr) toast.hide();
      else toast(translate("toast.opened"), "success");
    } catch (error) {
      toast(String(error), "error");
    }
  });
}

/** Shows one-time backend notices such as global-hotkey registration conflicts. */
export async function showStartupNotices(translate: Translate, toast: Toast): Promise<void> {
  try {
    const notices = await takeStartupNotices();
    for (const notice of notices) {
      if (notice.kind === "hotkey_fallback") {
        toast(
          translate("notice.hotkeyFallback", {
            wanted: notice.wanted ?? "",
            used: notice.used ?? "",
          }),
          "info",
        );
      } else if (notice.kind === "hotkey_conflict") {
        toast(translate("notice.hotkeyConflict", { wanted: notice.wanted ?? "" }), "error");
      }
    }
  } catch {
    // Startup notices are non-essential and should never block the viewer.
  }
}

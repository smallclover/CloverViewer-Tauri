import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { takeStartupNotices } from "../api";
import { setAnimatedVisibility, type ToastKind } from "./presentation";

type Toast = (message: string, kind?: ToastKind) => void;
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
  openPath: (path: string) => Promise<void>,
  translate: Translate,
  toast: Toast,
): Promise<void> {
  await listen<{ path: string }>("open-image", async (event) => {
    const path = event.payload?.path;
    if (!path) return;
    try {
      await openPath(path);
      toast(translate("toast.opened"), "success");
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

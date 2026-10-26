import { getCurrentWindow } from "@tauri-apps/api/window";
import { listenOpenImage, takeStartupNotices, type OpenImagePayload } from "../api";
import { setAnimatedVisibility, type ToastKind } from "./presentation";

type Toast = (message: string, kind?: ToastKind, persistent?: boolean) => void;
type ProgressToast = Toast & { hide: () => void };
type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 把 Tauri 拖放事件的载荷接到主查看器的文件打开流程上。 */
export function bindFileDrop(
  overlay: HTMLElement,
  openPath: (path: string) => Promise<boolean | undefined>,
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

/** 打开后端已落成临时图片文件的截图。 */
export async function bindOpenImageBridge(
  openPath: (payload: OpenImagePayload) => Promise<boolean | undefined>,
  translate: Translate,
  toast: ProgressToast,
): Promise<void> {
  await listenOpenImage(async (payload) => {
    if (!payload?.path) return;
    const isOcr = typeof payload.ocr_text === "string" || payload.ocr_document?.version === 1;
    if (isOcr) toast(translate("toast.openingOcr"), "progress", true);
    try {
      const opened = await openPath(payload);
      if (opened === false) {
        if (isOcr) toast.hide();
        return;
      }
      if (isOcr) toast.hide();
      else
        toast(translate(payload.edit_context ? "toast.openedForEdit" : "toast.opened"), "success");
    } catch (error) {
      toast(String(error), "error");
    }
  });
}

/** 展示后端的一次性通知，例如全局快捷键注册冲突。 */
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
    // 启动通知并非必需，不能因它阻塞查看器。
  }
}

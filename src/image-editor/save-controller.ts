import type { EditedImageFormat, ImageEntry } from "../api";

interface SaveOptions {
  getEntry: () => ImageEntry | null;
  getFormat: () => EditedImageFormat;
  getSession: () => number;
  getRevision: () => number;
  prepare: () => void;
  exportPng: () => Promise<string>;
  choosePath: (entry: ImageEntry, format: EditedImageFormat) => Promise<string | null>;
  confirmOverwrite: (entry: ImageEntry) => Promise<boolean>;
  saveImage: (path: string, png: string, format: EditedImageFormat) => Promise<void>;
  markSaved: (revision: number) => void;
  onSaved: (path: string) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
  toast: (message: string, type: "success" | "error") => void;
}

/** 保存只提交当前快照的修订；晚到的完成不能清除后续修改或污染新会话。 */
export function createEditorSaveController(options: SaveOptions) {
  let busy = false;
  let pending = Promise.resolve();
  const write = async (path: string, format: EditedImageFormat, session: number) => {
    if (session !== options.getSession()) return;
    options.prepare();
    const revision = options.getRevision();
    const png = await options.exportPng();
    if (session !== options.getSession()) return;
    await options.saveImage(path, png, format);
    if (session !== options.getSession()) return;
    options.markSaved(revision);
    options.onSaved(path);
    options.toast(options.translate("editor.saved"), "success");
  };
  const run = (action: (entry: ImageEntry, session: number) => Promise<void>) => {
    const entry = options.getEntry();
    if (busy || !entry) return Promise.resolve();
    busy = true;
    const session = options.getSession();
    pending = (async () => {
      try {
        await action(entry, session);
      } catch (error) {
        if (session === options.getSession())
          options.toast(options.translate("editor.saveFailed", { msg: String(error) }), "error");
      } finally {
        busy = false;
      }
    })();
    return pending;
  };
  return {
    isBusy: () => busy,
    whenIdle: () => pending,
    saveAs: () =>
      run(async (entry, session) => {
        const format = options.getFormat();
        const path = await options.choosePath(entry, format);
        if (path) await write(path, format, session);
      }),
    overwrite: () =>
      run(async (entry, session) => {
        const extension = entry.name.split(".").pop()?.toLowerCase();
        const format =
          extension === "jpg" || extension === "jpeg"
            ? "jpeg"
            : extension === "png" || extension === "webp"
              ? extension
              : null;
        if (!format) {
          options.toast(options.translate("editor.overwriteUnsupported"), "error");
          return;
        }
        if (await options.confirmOverwrite(entry)) await write(entry.path, format, session);
      }),
  };
}

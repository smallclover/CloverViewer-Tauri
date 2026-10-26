import type { BeautifyDocument } from "../api";
import { beautyKey, cloneBeauty } from "./model";

/** Live preview stays editable; only a completed, changed round enters the editor's history. */
export function createBeautyTransaction<T extends { beauty: BeautifyDocument }>(options: {
  capture: () => T;
  clone: (value: T) => T;
  getRevision: () => number;
  setRevision: (value: number) => void;
  restoreBeauty: (value: BeautifyDocument) => void;
  commit: (before: T) => void;
}) {
  let before: T | null = null,
    revision = 0,
    originalKey = "";
  const changed = () => before !== null && originalKey !== beautyKey(options.capture().beauty);
  return {
    changed,
    before: () => before?.beauty ?? options.capture().beauty,
    begin() {
      if (before) return;
      before = options.clone(options.capture());
      originalKey = beautyKey(before.beauty);
      revision = options.getRevision();
    },
    finish() {
      if (!before) return;
      const original = before,
        commit = changed();
      before = null;
      if (commit) options.commit(original);
      else options.setRevision(revision);
    },
    revert() {
      if (!before) return;
      const original = before;
      before = null;
      options.restoreBeauty(cloneBeauty(original.beauty));
      options.setRevision(revision);
    },
    clear() {
      before = null;
    },
  };
}

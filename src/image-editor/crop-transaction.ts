import type { Rect } from "./geometry";

interface CropState {
  crop: Rect | null;
  rotation: number;
}

/** 裁剪取景先作为草稿；快照保留旋转状态用于恢复，显式应用后才进入编辑历史。 */
export function createCropTransaction<T extends CropState>(options: {
  capture: () => T;
  clone: (state: T) => T;
  getSize: () => { w: number; h: number };
  restore: (state: T) => void;
  commit: (before: T) => void;
}) {
  let before: T | null = null;
  const changed = () => {
    if (!before) return false;
    const current = options.capture();
    if (before.rotation !== current.rotation) return true;
    const full = { x: 0, y: 0, ...options.getSize() };
    const previous = before.crop ?? full;
    const next = current.crop ?? full;
    return (["x", "y", "w", "h"] as const).some(
      (key) => Math.abs(previous[key] - next[key]) > 1e-7,
    );
  };
  return {
    get active() {
      return before !== null;
    },
    changed,
    begin: () => {
      before ??= options.clone(options.capture());
    },
    finish: (apply: boolean) => {
      if (!before) return;
      const original = before;
      const commit = apply && changed();
      before = null;
      if (commit) options.commit(original);
      else options.restore(original);
    },
    clear: () => {
      before = null;
    },
  };
}

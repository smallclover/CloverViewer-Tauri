import type { DragMode } from "./editor-input";
import type { Pt, Rect, Tool } from "./geometry";

interface MagnifierState {
  enabled: boolean;
  scrollIdle: boolean;
  textEditing: boolean;
  overUI: boolean;
  point: Pt | null;
  selection: Rect | null;
  tool: Tool | null;
  dragMode: DragMode;
}

/** 框选前和框选中自动显示；选区确定后仅按住 Alt 临时查看画布像素。 */
export function createMagnifierVisibility(options: {
  getState: () => MagnifierState;
  onChange: () => void;
}) {
  let held = false;
  let focused = true;
  const reset = () => {
    held = false;
  };
  const keydown = (event: KeyboardEvent) => {
    const state = options.getState();
    if (
      event.key !== "Alt" ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing ||
      state.textEditing ||
      !state.enabled ||
      !state.scrollIdle
    )
      return;
    event.preventDefault();
    if (held) return;
    held = true;
    options.onChange();
  };
  const keyup = (event: KeyboardEvent) => {
    if (event.key !== "Alt" || !held) return;
    event.preventDefault();
    reset();
    options.onChange();
  };
  const blur = () => {
    focused = false;
    reset();
    options.onChange();
  };
  const focus = () => {
    focused = true;
    options.onChange();
  };
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  return {
    reset,
    getPoint: (): Pt | null => {
      const state = options.getState();
      const { point, selection, dragMode } = state;
      if (
        !focused ||
        !state.enabled ||
        !state.scrollIdle ||
        state.textEditing ||
        state.overUI ||
        !point
      )
        return null;
      if (held) return point;
      if (
        state.tool ||
        (dragMode !== "none" && dragMode !== "select" && dragMode !== "pending-win")
      )
        return null;
      return !selection || dragMode === "select" || dragMode === "pending-win" ? point : null;
    },
    dispose: () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
    },
  };
}

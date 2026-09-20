import type { Pt, Rect } from "./geometry";

export interface ParsedHotkey {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function parseHotkey(value: string): ParsedHotkey | null {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const hotkey: ParsedHotkey = { ctrl: false, alt: false, shift: false, key: "" };
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (["ctrl", "control", "cmd", "meta", "super", "cmdorctrl"].includes(normalized)) {
      hotkey.ctrl = true;
    } else if (normalized === "alt") {
      hotkey.alt = true;
    } else if (normalized === "shift") {
      hotkey.shift = true;
    } else {
      hotkey.key = normalized;
    }
  }
  return hotkey.key ? hotkey : null;
}

export function matchesHotkey(event: KeyboardEvent, hotkey: ParsedHotkey): boolean {
  const ctrlMatches = hotkey.ctrl
    ? event.ctrlKey || event.metaKey
    : !event.ctrlKey && !event.metaKey;
  return (
    ctrlMatches &&
    (hotkey.alt ? event.altKey : !event.altKey) &&
    (hotkey.shift ? event.shiftKey : !event.shiftKey) &&
    event.key.toLowerCase() === hotkey.key
  );
}

type ScrollPhase = "idle" | "armed" | "capturing" | "done";
type Action = "save" | "clipboard";

export function bindEditorShortcuts(options: {
  isTextEditing: () => boolean;
  getScrollPhase: () => ScrollPhase;
  getSelection: () => Rect | null;
  onStopScroll: () => void;
  onDiscardAndClose: () => void;
  onFinishScroll: () => void;
  onExitScroll: () => void;
  onStartScroll: () => void;
  onClose: () => void;
  onExport: (action: Action) => void;
  getCopyColorHotkey: () => string;
  getColorPoint: () => Pt | null;
  onCopyColor: (point: Pt) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
}): void {
  window.addEventListener("keydown", (event) => {
    if (options.isTextEditing()) return;
    const phase = options.getScrollPhase();
    if (phase === "capturing") {
      if (event.key === "Escape") {
        event.preventDefault();
        options.onStopScroll();
      }
      return;
    }
    if (phase === "done") {
      if (event.key === "Escape") {
        event.preventDefault();
        options.onDiscardAndClose();
      } else if (event.key === "Enter") {
        event.preventDefault();
        options.onFinishScroll();
      }
      return;
    }
    if (phase === "armed") {
      if (event.key === "Escape") {
        event.preventDefault();
        options.onExitScroll();
        return;
      }
      if (event.key === "Enter" && options.getSelection()?.w) {
        event.preventDefault();
        options.onStartScroll();
        return;
      }
    }
    if (event.key === "Escape") options.onClose();
    else if (event.key === "Enter" && options.getSelection()?.w) options.onExport("clipboard");
    else if (
      matchesHotkey(
        event,
        parseHotkey(options.getCopyColorHotkey()) ?? {
          ctrl: true,
          alt: false,
          shift: false,
          key: "c",
        },
      )
    ) {
      const point = options.getColorPoint();
      if (point) {
        event.preventDefault();
        options.onCopyColor(point);
      }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) options.onRedo();
      else options.onUndo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      options.onRedo();
    } else if (event.key === "Delete" || event.key === "Backspace") options.onDelete();
  });
}

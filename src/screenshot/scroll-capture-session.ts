import type { ScrollCaptureDone, ScrollCaptureProgress } from "../api";
import type { Rect } from "./geometry";

export type ScrollPhase = "idle" | "armed" | "capturing" | "done";

export interface ScrollCaptureSessionState {
  phase: ScrollPhase;
  progress: ScrollCaptureProgress | null;
  captureRect: Rect | null;
  result: ScrollCaptureDone | null;
  error: string;
  actionError: string;
  stopping: boolean;
  startedAt: number | null;
  elapsedMs: number | null;
  manualMode: boolean;
  hudOverlap: boolean;
  hudHiddenForSession: boolean;
}

function freshState(phase: ScrollPhase): ScrollCaptureSessionState {
  return {
    phase,
    progress: null,
    captureRect: null,
    result: null,
    error: "",
    actionError: "",
    stopping: false,
    startedAt: null,
    elapsedMs: null,
    manualMode: false,
    hudOverlap: false,
    hudHiddenForSession: false,
  };
}

/** State-only controller for a scroll-capture session.
 * Commands, DOM mutation and event subscription deliberately stay at its edges. */
export interface ScrollCaptureSession {
  state: ScrollCaptureSessionState;
  reset: (phase?: ScrollPhase) => void;
  arm: () => void;
  begin: (manualMode: boolean) => void;
  failToArm: (error: string) => void;
  restore: (progress: ScrollCaptureProgress | null, minX: number, minY: number) => void;
  receiveProgress: (progress: ScrollCaptureProgress, minX: number, minY: number) => void;
  receiveHudVisibility: (hidden: boolean, affectsHud: boolean) => boolean;
  receiveDone: (result: ScrollCaptureDone, now: number) => void;
}

export function createScrollCaptureSession(): ScrollCaptureSession {
  const state = freshState("idle");
  const reset = (phase: ScrollPhase = "idle") => Object.assign(state, freshState(phase));
  const arm = () => reset("armed");
  const begin = (manualMode: boolean) => {
    reset("capturing");
    state.manualMode = manualMode;
  };
  const failToArm = (error: string) => {
    state.phase = "armed";
    state.error = error;
    state.startedAt = null;
    state.elapsedMs = null;
    state.hudHiddenForSession = false;
  };
  const restore = (progress: ScrollCaptureProgress | null, minX: number, minY: number) => {
    reset("capturing");
    state.progress = progress;
    setCaptureRect(progress, minX, minY);
  };
  const setCaptureRect = (progress: ScrollCaptureProgress | null, minX: number, minY: number) => {
    const capture = progress?.capture;
    state.captureRect = capture
      ? { x: capture[0] - minX, y: capture[1] - minY, w: capture[2], h: capture[3] }
      : null;
  };
  const receiveProgress = (progress: ScrollCaptureProgress, minX: number, minY: number) => {
    state.progress = progress;
    state.stopping = progress.stage === "finishing";
    if (progress.method === "manual") state.manualMode = true;
    setCaptureRect(progress, minX, minY);
  };
  /** Returns whether the HUD DOM should apply this visibility update. */
  const receiveHudVisibility = (hidden: boolean, affectsHud: boolean) => {
    if (!affectsHud) return true;
    if (hidden) state.hudHiddenForSession = true;
    return !(!hidden && state.hudHiddenForSession && state.phase === "capturing");
  };
  const receiveDone = (result: ScrollCaptureDone, now: number) => {
    const startedAt = state.startedAt;
    state.startedAt = null;
    state.elapsedMs = result.ok && startedAt !== null ? now - startedAt : null;
    state.stopping = false;
    state.hudHiddenForSession = false;
    if (state.progress) state.progress = { ...state.progress, input_passthrough: false };
    if (result.ok) {
      state.result = result;
      state.phase = "done";
    } else {
      state.error = result.message || "";
      state.phase = "armed";
    }
  };
  return {
    state,
    reset,
    arm,
    begin,
    failToArm,
    restore,
    receiveProgress,
    receiveHudVisibility,
    receiveDone,
  };
}

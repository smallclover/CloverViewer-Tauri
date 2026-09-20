import { finishScrollCapture, startScrollCapture, stopScrollCapture } from "../api";
import type { Rect } from "./geometry";
import type { ScrollCaptureHud } from "./scroll-capture-hud";
import type { ScrollCaptureStartPanel } from "./scroll-capture-panel";
import type { ScrollCaptureSession } from "./scroll-capture-session";

const MIN_SELECTION_HEIGHT = 280;
const RECOMMENDED_SELECTION_HEIGHT = 400;
type Translate = (key: string, params?: Record<string, string | number>) => string;

interface ScrollCaptureControllerOptions {
  session: ScrollCaptureSession;
  panel: ScrollCaptureStartPanel;
  hud: ScrollCaptureHud;
  root: HTMLElement;
  toolbar: HTMLElement;
  helpBox: HTMLElement;
  clearOcr: () => void;
  closePopups: () => void;
  getSelection: () => Rect | null;
  getBounds: () => { minX: number; minY: number };
  translate: Translate;
  render: () => void;
  position: () => void;
  showNotice: (text: string, isError?: boolean) => void;
  closeScreenshot: () => Promise<void>;
}

export function createScrollCaptureController(options: ScrollCaptureControllerOptions) {
  const { session, panel, hud, translate: t } = options;
  const selectionOk = () => {
    const selection = options.getSelection();
    return !!selection && selection.w >= 32 && selection.h >= MIN_SELECTION_HEIGHT;
  };
  const selectionHint = () => {
    const selection = options.getSelection();
    if (!selection) return t("shot.scrollHint");
    if (selection.h < MIN_SELECTION_HEIGHT) {
      return t("shot.scrollTooShort", { h: Math.round(selection.h), min: MIN_SELECTION_HEIGHT });
    }
    if (selection.h < RECOMMENDED_SELECTION_HEIGHT) {
      return t("shot.scrollShortCaution", {
        h: Math.round(selection.h),
        recommended: RECOMMENDED_SELECTION_HEIGHT,
      });
    }
    return t("shot.scrollHint");
  };
  const formatElapsed = (elapsedMs: number) => {
    const seconds = Math.max(0, elapsedMs) / 1000;
    return t("shot.scrollElapsedSeconds", {
      seconds: seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds)),
    });
  };

  const syncUi = () => {
    const state = session.state;
    const selection = options.getSelection();
    const inScroll = state.phase !== "idle";
    options.root.style.background = inScroll ? "transparent" : "";
    options.toolbar.style.display = inScroll || !selection ? "none" : "flex";
    if (inScroll) {
      options.helpBox.style.display = "none";
      options.closePopups();
      options.clearOcr();
    } else options.helpBox.style.display = "";

    panel.panel.classList.toggle("open", state.phase === "armed" && !!selection);
    hud.hud.classList.toggle("open", state.phase === "capturing" || state.phase === "done");
    hud.hud.classList.toggle("clickthrough", !!state.progress?.input_passthrough);
    hud.selectionGlow.classList.toggle(
      "on",
      state.phase === "capturing" && !state.manualMode && state.progress?.method !== "manual",
    );
    if (state.phase !== "capturing") {
      hud.hud.classList.remove("hud-hidden");
      hud.selectionGlow.classList.remove("capture-hidden");
    }

    panel.startButton.disabled = !selectionOk();
    panel.fromTop.disabled = panel.manual.checked;
    panel.fromTopLabel.style.display = panel.manual.checked ? "none" : "flex";
    const tooShort = !!selection && selection.h < MIN_SELECTION_HEIGHT;
    const shortCaution =
      !!selection &&
      selection.h >= MIN_SELECTION_HEIGHT &&
      selection.h < RECOMMENDED_SELECTION_HEIGHT;
    panel.panelTitle.textContent = t("shot.scroll");
    panel.panelBadge.textContent = t("shot.scrollReady");
    panel.panelBadge.className = "sh-badge ok";
    panel.autoModeButton.textContent = t("shot.scrollAutoMode");
    panel.manualModeButton.textContent = t("shot.scrollManualModeShort");
    panel.autoModeButton.classList.toggle("active", !panel.manual.checked);
    panel.manualModeButton.classList.toggle("active", panel.manual.checked);
    panel.autoModeButton.setAttribute("aria-pressed", String(!panel.manual.checked));
    panel.manualModeButton.setAttribute("aria-pressed", String(panel.manual.checked));
    panel.selectionCard.style.display = selection ? "flex" : "none";
    panel.selectionLabel.textContent = t("shot.scrollSelectionLabel");
    panel.selectionValue.textContent = selection
      ? `${Math.round(selection.w)} × ${Math.round(selection.h)} px`
      : "—";
    panel.selectionState.textContent = tooShort
      ? `≥ ${MIN_SELECTION_HEIGHT}px`
      : selection && selection.h >= RECOMMENDED_SELECTION_HEIGHT
        ? t("shot.scrollHeightReady")
        : `≥ ${RECOMMENDED_SELECTION_HEIGHT}px`;
    panel.selectionState.className = `sh-selection-card-state${
      selection && selection.h >= RECOMMENDED_SELECTION_HEIGHT ? " ok" : " warn"
    }`;
    panel.hint.textContent = state.error
      ? t("shot.scrollFailed", { msg: state.error })
      : tooShort || shortCaution
        ? selectionHint()
        : panel.manual.checked
          ? t("shot.scrollManualHint")
          : t("shot.scrollAutoHint");
    panel.hint.className = `sh-status${state.error || tooShort ? " err" : shortCaution ? " warn" : ""}`;
    panel.startButton.textContent = panel.manual.checked
      ? t("shot.scrollManualStart")
      : t("shot.scrollStart");
    panel.quitButton.textContent = t("shot.scrollCancel");

    const progress = state.progress;
    const result = state.result;
    if (state.phase === "capturing") {
      hud.hud.classList.remove("result");
      hud.resultSummary.style.display = "none";
      hud.resultBody.style.display = "none";
      hud.actions.style.display = "flex";
      const manual = state.manualMode || progress?.method === "manual";
      hud.recDot.style.display = "";
      hud.titleText.textContent = manual
        ? t("shot.scrollManualCapturing")
        : t("shot.scrollCapturing");
      const stage = progress?.stage === "probing" ? t("shot.scrollProbing") : "";
      const low = progress?.stage === "low_confidence" ? t("shot.scrollStageLow") : "";
      hud.badge.textContent = state.stopping
        ? t(manual ? "shot.scrollManualFinishing" : "shot.scrollStopping")
        : stage || (manual ? t("shot.scrollManualBadge") : t("shot.scrollCapturing"));
      hud.badge.className = `sh-badge${low ? " warn" : " recording"}`;
      hud.metrics.style.display = "grid";
      hud.primaryMetric.label.textContent = t("shot.scrollCaptured");
      hud.primaryMetric.value.textContent =
        progress && progress.height > 0 ? `${progress.height}px` : "—";
      hud.secondaryMetric.label.textContent = t("shot.scrollFrameCount");
      hud.secondaryMetric.value.textContent = progress ? String(progress.frames) : "—";
      hud.status.textContent = state.stopping
        ? t(manual ? "shot.scrollManualFinishing" : "shot.scrollStopping")
        : "";
      hud.status.className = `sh-status${low ? " warn" : ""}`;
      const detail = low || stage || progress?.message || "";
      hud.detail.textContent = detail;
      hud.detail.className = `sh-detail${detail ? " on" : ""}${low ? " warn" : ""}`;
      hud.preview.classList.remove("on");
      hud.stopButton.style.display = state.progress?.input_passthrough ? "none" : "";
      hud.stopButton.disabled = state.stopping;
      hud.stopButton.textContent = t(manual ? "shot.scrollManualFinish" : "shot.scrollStop");
      hud.escStop.textContent = t(manual ? "shot.scrollManualEscFinish" : "shot.scrollEscStop");
      hud.escStop.classList.toggle("on", !!state.progress?.input_passthrough);
    } else if (state.phase === "done" && result) {
      hud.hud.classList.add("result");
      hud.actions.style.display = "none";
      hud.resultSummary.style.display = "grid";
      hud.resultBody.style.display = "grid";
      hud.recDot.style.display = "none";
      hud.titleText.textContent = t("shot.scrollDone");
      hud.badge.textContent =
        result.confidence === "high"
          ? t("shot.scrollConfHigh")
          : result.confidence === "partial"
            ? t("shot.scrollConfPartial")
            : t("shot.scrollConfLow");
      hud.badge.className = `sh-badge${result.confidence === "high" ? " ok" : " warn"}`;
      hud.metrics.style.display = "none";
      hud.resultSizeLabel.textContent = t("shot.scrollDimensions");
      hud.resultSize.textContent = t("shot.scrollSize", {
        w: result.width ?? 0,
        h: result.height ?? 0,
      });
      hud.resultFramesLabel.textContent = t("shot.scrollFrameCount");
      hud.resultFrames.textContent = t("shot.scrollFrames", { count: result.frames ?? 0 });
      hud.resultElapsed.style.display = state.elapsedMs === null ? "none" : "";
      hud.resultElapsed.textContent =
        state.elapsedMs === null
          ? ""
          : t("shot.scrollElapsed", { time: formatElapsed(state.elapsedMs) });
      hud.status.textContent = state.actionError;
      hud.status.className = `sh-status${state.actionError ? " err" : ""}`;
      hud.detail.textContent = state.actionError || result.message || "";
      hud.detail.className = `sh-detail${state.actionError || result.message ? " on" : ""}${result.confidence === "high" && !state.actionError ? "" : " warn"}`;
      hud.escStop.classList.remove("on");
      const hasPreview = !!state.progress?.preview;
      hud.preview.classList.toggle("on", hasPreview);
      hud.previewSlot.style.display = hasPreview ? "grid" : "none";
      hud.resultBody.classList.toggle("without-preview", !hasPreview);
      if (state.progress?.preview) hud.preview.src = state.progress.preview;
      hud.copyButton.classList.remove("primary");
      hud.saveButton.classList.remove("primary");
      hud.openButton.classList.add("primary");
      hud.copyButton.textContent = t("shot.scrollCopy");
      hud.saveButton.textContent = t("shot.scrollSave");
      hud.openButton.textContent = t("shot.scrollOpen");
    }
    options.position();
  };

  const begin = async () => {
    const selection = options.getSelection();
    if (!selection || !selectionOk()) {
      panel.hint.textContent = selectionHint();
      panel.hint.className = "sh-status err";
      return;
    }
    session.begin(panel.manual.checked);
    hud.selectionGlow.classList.remove("capture-hidden");
    syncUi();
    options.render();
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    try {
      session.state.startedAt = performance.now();
      const { minX, minY } = options.getBounds();
      await startScrollCapture({
        x: Math.round(selection.x + minX),
        y: Math.round(selection.y + minY),
        w: Math.round(selection.w),
        h: Math.round(selection.h),
        mode: session.state.manualMode ? "manual" : "auto",
        auto_scroll_top: !session.state.manualMode && panel.fromTop.checked,
        hide_hud_during_capture: session.state.hudOverlap,
        hide_glow_during_capture: !session.state.manualMode,
      });
    } catch (error) {
      hud.hud.classList.remove("hud-hidden");
      hud.selectionGlow.classList.remove("capture-hidden");
      session.failToArm(String(error));
      syncUi();
      options.render();
    }
  };
  const stop = () => {
    if (session.state.phase !== "capturing" || session.state.stopping) return;
    session.state.stopping = true;
    syncUi();
    void stopScrollCapture();
  };
  const finish = async (action: "save" | "clipboard" | "open") => {
    try {
      const path = await finishScrollCapture(action);
      if (action === "clipboard") {
        options.showNotice(t("shot.scrollCopied"));
        return;
      }
      if (action === "save")
        options.showNotice(path ? t("shot.savedTo", { path }) : t("shot.scrollSaved"));
      await options.closeScreenshot();
    } catch (error) {
      session.state.actionError = t(
        action === "open"
          ? "shot.scrollOpenFailed"
          : action === "save"
            ? "shot.scrollSaveFailed"
            : "shot.scrollCopyFailed",
        { msg: String(error) },
      );
      options.showNotice(session.state.actionError, true);
      syncUi();
      options.render();
    }
  };
  return { syncUi, begin, stop, finish };
}

export interface ScrollCaptureMetric {
  root: HTMLDivElement;
  label: HTMLDivElement;
  value: HTMLDivElement;
}

export interface ScrollCaptureHud {
  selectionGlow: HTMLDivElement;
  hud: HTMLDivElement;
  notice: HTMLDivElement;
  titleText: HTMLSpanElement;
  badge: HTMLSpanElement;
  recDot: HTMLSpanElement;
  captureBody: HTMLDivElement;
  resultHeader: HTMLDivElement;
  resultTitleText: HTMLSpanElement;
  resultBadge: HTMLSpanElement;
  statusLabel: HTMLSpanElement;
  infoLabel: HTMLSpanElement;
  messageLabel: HTMLSpanElement;
  metrics: HTMLDivElement;
  primaryMetric: ScrollCaptureMetric;
  secondaryMetric: ScrollCaptureMetric;
  status: HTMLDivElement;
  detail: HTMLDivElement;
  livePreview: HTMLImageElement;
  livePreviewSlot: HTMLDivElement;
  livePreviewLabel: HTMLDivElement;
  candidatePreview: HTMLImageElement;
  candidatePreviewSlot: HTMLDivElement;
  candidatePreviewLabel: HTMLDivElement;
  preview: HTMLImageElement;
  previewSlot: HTMLDivElement;
  resultSummary: HTMLDivElement;
  resultSizeLabel: HTMLSpanElement;
  resultSize: HTMLElement;
  resultFramesLabel: HTMLSpanElement;
  resultFrames: HTMLElement;
  resultElapsed: HTMLDivElement;
  actions: HTMLDivElement;
  resultBody: HTMLDivElement;
  stopButton: HTMLButtonElement;
  copyButton: HTMLButtonElement;
  saveButton: HTMLButtonElement;
  openButton: HTMLButtonElement;
  escStop: HTMLDivElement;
}

interface ScrollCaptureHudOptions {
  uiLayer: HTMLElement;
  onStop: () => void;
  onAction: (action: "clipboard" | "save" | "open") => void;
  onLayout: () => void;
}

function createMetric(): ScrollCaptureMetric {
  const root = document.createElement("div");
  root.className = "sh-metric";
  const label = document.createElement("div");
  label.className = "sh-metric-label";
  const value = document.createElement("div");
  value.className = "sh-metric-value";
  root.append(label, value);
  return { root, label, value };
}

function createButton(onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "sh-btn";
  button.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    event.preventDefault();
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/**
 * 创建滚动截图的进度/结果 HUD 与一次性提示层。
 *
 * 该模块仅负责稳定的 DOM 树和局部按钮交互；状态到文案/样式的映射仍由会话控制器处理。
 */
export function createScrollCaptureHud({
  uiLayer,
  onStop,
  onAction,
  onLayout,
}: ScrollCaptureHudOptions): ScrollCaptureHud {
  const selectionGlow = document.createElement("div");
  selectionGlow.id = "scroll-selection-glow";
  uiLayer.appendChild(selectionGlow);

  const hud = document.createElement("div");
  hud.id = "scroll-hud";
  hud.className = "ui-interactive";
  const title = document.createElement("div");
  title.className = "sh-title";
  // 红点只创建一次，否则进度更新会重启 CSS 呼吸动画。
  const recDot = document.createElement("span");
  recDot.className = "sh-rec";
  const titleText = document.createElement("span");
  title.append(recDot, titleText);
  const head = document.createElement("div");
  head.className = "sh-head";
  const badge = document.createElement("span");
  badge.className = "sh-badge";
  head.append(title, badge);

  const metrics = document.createElement("div");
  metrics.className = "sh-metrics";
  const primaryMetric = createMetric();
  const secondaryMetric = createMetric();
  metrics.append(primaryMetric.root, secondaryMetric.root);
  const status = document.createElement("div");
  status.className = "sh-status";
  const detail = document.createElement("div");
  detail.className = "sh-detail";

  const livePreview = document.createElement("img");
  livePreview.className = "sh-preview sh-live-preview";
  const livePreviewSlot = document.createElement("div");
  livePreviewSlot.className = "sh-live-preview-slot";
  const livePreviewLabel = document.createElement("div");
  livePreviewLabel.className = "sh-live-preview-label";
  const candidatePreview = document.createElement("img");
  candidatePreview.className = "sh-preview sh-candidate-preview";
  const candidatePreviewSlot = document.createElement("div");
  candidatePreviewSlot.className = "sh-candidate-preview-slot";
  const candidatePreviewLabel = document.createElement("div");
  candidatePreviewLabel.className = "sh-candidate-preview-label";
  candidatePreviewSlot.append(candidatePreview, candidatePreviewLabel);
  livePreviewSlot.append(livePreview, livePreviewLabel, candidatePreviewSlot);

  const captureBody = document.createElement("div");
  captureBody.className = "sh-capture-body";
  const captureSide = document.createElement("div");
  captureSide.className = "sh-capture-side";
  const statusModule = document.createElement("section");
  statusModule.className = "sh-capture-module";
  const statusLabel = document.createElement("span");
  statusLabel.className = "sh-capture-module-label";
  statusModule.append(statusLabel, head, status);
  const infoModule = document.createElement("section");
  infoModule.className = "sh-capture-module";
  const infoLabel = document.createElement("span");
  infoLabel.className = "sh-capture-module-label";
  infoModule.append(infoLabel, metrics);
  const messageModule = document.createElement("section");
  messageModule.className = "sh-capture-module";
  const messageLabel = document.createElement("span");
  messageLabel.className = "sh-capture-module-label";
  messageModule.append(messageLabel, detail);

  const resultHeader = document.createElement("div");
  resultHeader.className = "sh-result-header";
  const resultTitleText = document.createElement("span");
  resultTitleText.className = "sh-result-title";
  const resultBadge = document.createElement("span");
  resultBadge.className = "sh-badge";
  resultHeader.append(resultTitleText, resultBadge);

  const preview = document.createElement("img");
  preview.className = "sh-preview";
  const resultSummary = document.createElement("div");
  resultSummary.className = "sh-result-summary";
  const resultSizeMetric = document.createElement("div");
  resultSizeMetric.className = "sh-result-metric";
  const resultSizeLabel = document.createElement("span");
  resultSizeLabel.className = "sh-result-metric-label";
  const resultSize = document.createElement("strong");
  resultSizeMetric.append(resultSizeLabel, resultSize);
  const resultFramesMetric = document.createElement("div");
  resultFramesMetric.className = "sh-result-metric";
  const resultFramesLabel = document.createElement("span");
  resultFramesLabel.className = "sh-result-metric-label";
  const resultFrames = document.createElement("strong");
  resultFramesMetric.append(resultFramesLabel, resultFrames);
  resultSummary.append(resultSizeMetric, resultFramesMetric);
  const resultElapsed = document.createElement("div");
  resultElapsed.className = "sh-result-context";
  const previewSlot = document.createElement("div");
  previewSlot.className = "sh-preview-slot";
  previewSlot.appendChild(preview);
  const actions = document.createElement("div");
  actions.className = "sh-actions";
  const resultActions = document.createElement("div");
  resultActions.className = "sh-result-actions";
  const resultBody = document.createElement("div");
  resultBody.className = "sh-result-body";
  const resultSide = document.createElement("div");
  resultSide.className = "sh-result-side";

  const stopButton = createButton(onStop);
  const copyButton = createButton(() => onAction("clipboard"));
  const saveButton = createButton(() => onAction("save"));
  const openButton = createButton(() => onAction("open"));
  const escStop = document.createElement("div");
  escStop.className = "sh-esc-stop";
  actions.append(stopButton);
  resultActions.append(copyButton, saveButton, openButton);
  resultSide.append(resultSummary, resultElapsed, resultActions);
  resultBody.append(previewSlot, resultSide);
  captureSide.append(statusModule, infoModule, messageModule, escStop, actions);
  captureBody.append(livePreviewSlot, captureSide);
  hud.append(captureBody, resultHeader, resultBody);
  uiLayer.appendChild(hud);

  // 缩略图和翻译文案会在结果显示后改变 HUD 的实际尺寸，因此用 ResizeObserver 重新落位。
  let layoutPending = false;
  const scheduleLayout = () => {
    if (layoutPending) return;
    layoutPending = true;
    window.requestAnimationFrame(() => {
      layoutPending = false;
      if (hud.classList.contains("open")) onLayout();
    });
  };
  new ResizeObserver(scheduleLayout).observe(hud);
  preview.addEventListener("load", scheduleLayout);
  preview.addEventListener("error", scheduleLayout);
  livePreview.addEventListener("load", scheduleLayout);
  livePreview.addEventListener("error", scheduleLayout);
  candidatePreview.addEventListener("load", scheduleLayout);
  candidatePreview.addEventListener("error", scheduleLayout);

  const notice = document.createElement("div");
  notice.id = "scroll-notice";
  notice.className = "ui-interactive";
  uiLayer.appendChild(notice);

  return {
    selectionGlow,
    hud,
    notice,
    titleText,
    badge,
    recDot,
    captureBody,
    resultHeader,
    resultTitleText,
    resultBadge,
    statusLabel,
    infoLabel,
    messageLabel,
    metrics,
    primaryMetric,
    secondaryMetric,
    status,
    detail,
    livePreview,
    livePreviewSlot,
    livePreviewLabel,
    candidatePreview,
    candidatePreviewSlot,
    candidatePreviewLabel,
    preview,
    previewSlot,
    resultSummary,
    resultSizeLabel,
    resultSize,
    resultFramesLabel,
    resultFrames,
    resultElapsed,
    actions,
    resultBody,
    stopButton,
    copyButton,
    saveButton,
    openButton,
    escStop,
  };
}

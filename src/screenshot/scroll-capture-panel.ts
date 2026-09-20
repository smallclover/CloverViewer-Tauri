export interface ScrollCaptureStartPanel {
  panel: HTMLDivElement;
  autoModeButton: HTMLButtonElement;
  manualModeButton: HTMLButtonElement;
  panelTitle: HTMLDivElement;
  panelBadge: HTMLSpanElement;
  selectionCard: HTMLDivElement;
  selectionLabel: HTMLSpanElement;
  selectionState: HTMLSpanElement;
  selectionValue: HTMLDivElement;
  hint: HTMLDivElement;
  startButton: HTMLButtonElement;
  quitButton: HTMLButtonElement;
  fromTop: HTMLInputElement;
  fromTopLabel: HTMLLabelElement;
  manual: HTMLInputElement;
}

interface ScrollCaptureStartPanelOptions {
  uiLayer: HTMLElement;
  onStart: () => void;
  onQuit: () => void;
  onModeChange: () => void;
}

/**
 * 构建滚动截图的启动配置面板。
 *
 * 面板只持有 DOM 控件及其局部交互；会话状态、文案和可见性仍由 screenshot.ts 的
 * 状态机统一协调，避免 UI 层反向依赖滚动截图流程。
 */
export function createScrollCaptureStartPanel({
  uiLayer,
  onStart,
  onQuit,
  onModeChange,
}: ScrollCaptureStartPanelOptions): ScrollCaptureStartPanel {
  const panel = document.createElement("div");
  panel.id = "scroll-panel";
  panel.className = "ui-interactive";

  const panelTitle = document.createElement("div");
  panelTitle.className = "sh-title";
  const panelHead = document.createElement("div");
  panelHead.className = "sh-head";
  const panelBadge = document.createElement("span");
  panelBadge.className = "sh-badge";
  panelHead.append(panelTitle, panelBadge);

  const modeSwitch = document.createElement("div");
  modeSwitch.className = "sh-mode-switch";
  const autoModeButton = document.createElement("button");
  autoModeButton.type = "button";
  autoModeButton.className = "sh-mode-btn";
  const manualModeButton = document.createElement("button");
  manualModeButton.type = "button";
  manualModeButton.className = "sh-mode-btn";
  modeSwitch.append(autoModeButton, manualModeButton);

  const selectionCard = document.createElement("div");
  selectionCard.className = "sh-selection-card";
  const selectionCardHead = document.createElement("div");
  selectionCardHead.className = "sh-selection-card-head";
  const selectionLabel = document.createElement("span");
  selectionLabel.className = "sh-selection-card-label";
  const selectionState = document.createElement("span");
  selectionState.className = "sh-selection-card-state";
  selectionCardHead.append(selectionLabel, selectionState);
  const selectionValue = document.createElement("div");
  selectionValue.className = "sh-selection-card-value";
  selectionCard.append(selectionCardHead, selectionValue);

  const hint = document.createElement("div");
  hint.className = "sh-status";

  const actions = document.createElement("div");
  actions.className = "sh-actions";
  const startButton = document.createElement("button");
  startButton.className = "sh-btn primary";
  startButton.addEventListener("click", (event) => {
    event.stopPropagation();
    onStart();
  });
  const quitButton = document.createElement("button");
  quitButton.className = "sh-btn";
  quitButton.addEventListener("click", (event) => {
    event.stopPropagation();
    onQuit();
  });
  actions.append(startButton, quitButton);

  // 默认从当前可见位置开始；自动模式下才允许选择先回到页面顶部。
  const fromTop = document.createElement("input");
  fromTop.type = "checkbox";
  fromTop.id = "sh-from-top";
  const fromTopLabel = document.createElement("label");
  fromTopLabel.className = "sh-option-row";
  fromTopLabel.htmlFor = "sh-from-top";
  // data-i18n 不能放在 label 上：applyI18n 会覆盖其 textContent，从而删掉 checkbox。
  fromTopLabel.append(fromTop);
  const fromTopText = document.createElement("span");
  fromTopText.dataset.i18n = "shot.scrollFromTopShort";
  fromTopLabel.append(fromTopText);

  // 保留 checkbox 作为模式的唯一数据源，避免启动请求与视觉状态脱节。
  const manual = document.createElement("input");
  manual.type = "checkbox";
  manual.id = "sh-manual";
  manual.addEventListener("change", onModeChange);
  autoModeButton.addEventListener("click", () => {
    if (!manual.checked) return;
    manual.checked = false;
    onModeChange();
  });
  manualModeButton.addEventListener("click", () => {
    if (manual.checked) return;
    manual.checked = true;
    onModeChange();
  });

  panel.append(panelHead, modeSwitch, selectionCard, hint, fromTopLabel, actions);
  uiLayer.appendChild(panel);

  return {
    panel,
    autoModeButton,
    manualModeButton,
    panelTitle,
    panelBadge,
    selectionCard,
    selectionLabel,
    selectionState,
    selectionValue,
    hint,
    startButton,
    quitButton,
    fromTop,
    fromTopLabel,
    manual,
  };
}

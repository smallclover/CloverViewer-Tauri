interface EditorConfirmDialogOptions {
  workspace: HTMLElement;
}

interface ConfirmRequest {
  title: string;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
}

/** 图片编辑器内的危险操作确认框，避免使用系统或 WebView 的原生弹窗。 */
export function createEditorConfirmDialog({ workspace }: EditorConfirmDialogOptions) {
  const element = document.createElement("div");
  element.className = "image-editor-confirm-overlay";
  element.hidden = true;
  element.setAttribute("role", "alertdialog");
  element.setAttribute("aria-modal", "true");

  const panel = document.createElement("section");
  panel.className = "image-editor-confirm-panel";
  const icon = document.createElement("span");
  icon.className = "image-editor-confirm-icon";
  icon.ariaHidden = "true";
  icon.textContent = "!";
  const copy = document.createElement("div");
  copy.className = "image-editor-confirm-copy";
  const title = document.createElement("h2");
  title.id = "image-editor-confirm-title";
  const message = document.createElement("p");
  message.id = "image-editor-confirm-message";
  copy.append(title, message);
  const actions = document.createElement("div");
  actions.className = "image-editor-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "image-editor-confirm-cancel";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "image-editor-confirm-accept";
  actions.append(cancel, accept);
  panel.append(icon, copy, actions);
  element.append(panel);
  element.setAttribute("aria-labelledby", title.id);
  element.setAttribute("aria-describedby", message.id);
  workspace.append(element);

  let settle: ((accepted: boolean) => void) | null = null;
  let restoreFocus: HTMLElement | null = null;
  const close = (accepted: boolean) => {
    if (!settle) return;
    element.hidden = true;
    const resolve = settle;
    settle = null;
    resolve(accepted);
    restoreFocus?.focus();
    restoreFocus = null;
  };
  cancel.addEventListener("click", () => close(false));
  accept.addEventListener("click", () => close(true));
  element.addEventListener("pointerdown", (event) => {
    if (event.target !== element) return;
    event.preventDefault();
    close(false);
  });
  element.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Tab") {
      event.preventDefault();
      (document.activeElement === cancel ? accept : cancel).focus();
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (!event.repeat) close(false);
  });

  return {
    isOpen: () => !element.hidden,
    ask: ({
      title: titleText,
      message: messageText,
      cancelLabel,
      confirmLabel,
    }: ConfirmRequest) => {
      if (settle) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        restoreFocus =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        title.textContent = titleText;
        message.textContent = messageText;
        cancel.textContent = cancelLabel;
        accept.textContent = confirmLabel;
        settle = resolve;
        element.hidden = false;
        window.requestAnimationFrame(() => {
          if (!element.hidden) cancel.focus();
        });
      });
    },
  };
}

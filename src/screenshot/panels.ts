import { t } from "../i18n";
import { makeBtn } from "./icons";

export interface HelpPanel {
  element: HTMLDivElement;
  sync(copyColorHotkey: string, magnifierActive: boolean): void;
}

export function createHelpPanel(uiLayer: HTMLElement): HelpPanel {
  const element = document.createElement("div");
  element.id = "help-box";
  const rows: { kbdI18n?: string; kbd?: string; labelI18n: string }[] = [
    { kbdI18n: "shot.hint.dragKey", labelI18n: "shot.hint.drag" },
    { kbdI18n: "shot.hint.clickKey", labelI18n: "shot.hint.click" },
    { kbd: "Enter", labelI18n: "shot.hint.enter" },
    { kbd: "Esc", labelI18n: "shot.hint.esc" },
    { kbd: "Delete", labelI18n: "shot.hint.delete" },
    { kbd: "Ctrl+Z", labelI18n: "shot.hint.undo" },
    { kbd: "Ctrl+Y", labelI18n: "shot.hint.redo" },
  ];
  const makeRow = (kbdText: string, labelI18n: string, kbdI18n?: string) => {
    const row = document.createElement("div");
    row.className = "hint";
    const kbd = document.createElement("kbd");
    if (kbdI18n) kbd.dataset.i18n = kbdI18n;
    kbd.textContent = kbdI18n ? t(kbdI18n) : kbdText;
    const label = document.createElement("span");
    label.dataset.i18n = labelI18n;
    label.textContent = t(labelI18n);
    row.append(kbd, label);
    return row;
  };
  for (const row of rows) element.appendChild(makeRow(row.kbd ?? "", row.labelI18n, row.kbdI18n));
  const colorRow = makeRow("Alt+C", "shot.hint.copyColor");
  const colorKey = colorRow.querySelector("kbd") as HTMLElement;
  element.appendChild(colorRow);
  uiLayer.appendChild(element);
  return {
    element,
    sync(copyColorHotkey, magnifierActive) {
      colorKey.textContent = copyColorHotkey;
      colorRow.style.display = magnifierActive ? "" : "none";
    },
  };
}

export interface OcrPanel {
  element: HTMLDivElement;
  show(text: string, isError: boolean): void;
  hide(): void;
}

export function createOcrPanel(uiLayer: HTMLElement, onCopy: (text: string) => void): OcrPanel {
  const element = document.createElement("div");
  element.id = "ocr-panel";
  element.className = "ui-interactive";
  element.style.display = "none";
  const header = document.createElement("div");
  header.className = "ocr-header";
  const title = document.createElement("span");
  title.className = "ocr-title";
  title.dataset.i18n = "shot.ocrTitle";
  title.textContent = t("shot.ocrTitle");
  const body = document.createElement("div");
  body.className = "ocr-body";
  const copy = makeBtn("copy", "shot.copyAll");
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    onCopy(body.textContent || "");
  });
  const close = makeBtn("cancel", "shot.close");
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    element.style.display = "none";
  });
  header.append(title, copy, close);
  element.append(header, body);
  uiLayer.appendChild(element);
  return {
    element,
    show(text, isError) {
      body.textContent = text;
      body.classList.toggle("error", isError);
      element.style.display = "flex";
    },
    hide() {
      element.style.display = "none";
    },
  };
}

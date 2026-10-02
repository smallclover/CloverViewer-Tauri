import type { Tool } from "./geometry";
import { makeBtn, svgIcon } from "./icons";
import { t } from "../i18n";
import { SIZE_LABELS, SIZE_PRESETS, sizeKind } from "../image-editor/annotation-style";

export interface ToolbarOptions {
  uiLayer: HTMLElement;
  color: string;
  getSize: () => number;
  getTool: () => Tool | null;
  onToolChange: (tool: Tool | null) => void;
  onOcr: () => void;
  onReselect: () => void;
  onCancel: () => void;
  onExport: (action: "clipboard" | "save" | "open") => void;
  onShare: () => void;
  onColorChange: (color: string) => void;
  onSizeChange: (size: number) => void;
}

export interface ToolbarUi {
  toolbar: HTMLDivElement;
  toolBtns: Map<Tool, HTMLButtonElement>;
  ocrButton: HTMLButtonElement;
  colorBtn: HTMLButtonElement;
  widthBtn: HTMLButtonElement;
  colorPopup: HTMLDivElement;
  widthPopup: HTMLDivElement;
  closePopups(): void;
  setActionBusy(busy: boolean): void;
  syncColor(color: string): void;
  syncSize(): void;
}

const tools: { tool: Tool; icon: string; title: string }[] = [
  { tool: "rect", icon: "rect", title: "shot.rect" },
  { tool: "circle", icon: "circle", title: "shot.circle" },
  { tool: "arrow", icon: "arrow", title: "shot.arrow" },
  { tool: "pen", icon: "pen", title: "shot.pen" },
  { tool: "mosaic", icon: "mosaic", title: "shot.mosaic" },
  { tool: "text", icon: "text", title: "shot.text" },
];

const palette = [
  "#cc0000",
  "#ff0000",
  "#ff6600",
  "#ffcc00",
  "#00cc00",
  "#0099ff",
  "#0000ff",
  "#9900ff",
  "#000000",
  "#ffffff",
];

function stopMouseDown(event: MouseEvent) {
  event.stopPropagation();
  event.preventDefault();
}

export function createToolbar(options: ToolbarOptions): ToolbarUi {
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar ui-interactive";
  const toolBtns = new Map<Tool, HTMLButtonElement>();
  for (const { tool, icon, title } of tools) {
    const button = makeBtn(icon, title);
    button.addEventListener("mousedown", stopMouseDown);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      options.onToolChange(options.getTool() === tool ? null : tool);
    });
    toolBtns.set(tool, button);
    toolbar.appendChild(button);
  }

  const ocr = makeBtn("ocr", "shot.ocr");
  ocr.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onOcr();
  });
  toolbar.appendChild(ocr);
  const addDivider = () => {
    const divider = document.createElement("div");
    divider.className = "divider";
    toolbar.appendChild(divider);
  };
  addDivider();

  const colorBtn = makeBtn("color", "shot.color");
  const colorSwatch = document.createElement("div");
  colorSwatch.className = "swatch";
  colorBtn.replaceChildren(colorSwatch);
  toolbar.appendChild(colorBtn);
  const widthBtn = makeBtn("width", "shot.width");
  widthBtn.classList.add("size-settings");
  widthBtn.setAttribute("aria-haspopup", "true");
  const sizeIcon = document.createElement("span");
  sizeIcon.className = "size-icon";
  sizeIcon.setAttribute("aria-hidden", "true");
  const sizeValue = document.createElement("span");
  sizeValue.className = "size-value";
  const sizeChevron = document.createElement("span");
  sizeChevron.className = "size-chevron";
  sizeChevron.setAttribute("aria-hidden", "true");
  widthBtn.replaceChildren(sizeIcon, sizeValue, sizeChevron);
  toolbar.appendChild(widthBtn);
  addDivider();

  const reselect = makeBtn("reselect", "shot.reselect");
  reselect.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onReselect();
  });
  const cancel = makeBtn("cancel", "shot.cancel");
  cancel.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onCancel();
  });
  const copy = makeBtn("copy", "shot.copy");
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onExport("clipboard");
  });
  const save = makeBtn("save", "shot.save");
  save.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onExport("save");
  });
  const share = makeBtn("share", "shot.share");
  share.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onShare();
  });
  const open = makeBtn("open", "shot.open");
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onExport("open");
  });
  toolbar.append(reselect, cancel, share, save, open, copy);

  const colorPopup = document.createElement("div");
  colorPopup.className = "popup ui-interactive";
  const paletteElement = document.createElement("div");
  paletteElement.className = "palette";
  const native = document.createElement("input");
  native.type = "color";
  native.className = "native";
  native.addEventListener("input", () => options.onColorChange(native.value));
  for (const color of palette) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.style.background = color;
    cell.addEventListener("click", () => {
      options.onColorChange(color);
      closePopups();
    });
    paletteElement.appendChild(cell);
  }
  paletteElement.appendChild(native);
  colorPopup.appendChild(paletteElement);

  const widthPopup = document.createElement("div");
  widthPopup.className = "popup ui-interactive";
  const sizeHeading = document.createElement("strong");
  sizeHeading.className = "size-heading";
  const widthList = document.createElement("div");
  widthList.className = "width-list";
  widthPopup.append(sizeHeading, widthList);
  const sizeHint = document.createElement("div");
  sizeHint.className = "size-hint";
  sizeHint.dataset.i18n = "editor.sizePixels";
  sizeHint.textContent = t("editor.sizePixels");
  widthPopup.appendChild(sizeHint);
  options.uiLayer.append(toolbar, colorPopup, widthPopup);

  function closePopups() {
    colorPopup.classList.remove("open");
    widthPopup.classList.remove("open");
  }
  function setActionBusy(busy: boolean) {
    for (const button of [ocr, copy, save, share, open]) button.disabled = busy;
  }
  function syncColor(color: string) {
    colorSwatch.style.background = color;
    native.value = color;
    colorPopup.querySelectorAll(".cell").forEach((cell) => {
      cell.classList.toggle("sel", (cell as HTMLElement).style.background === color);
    });
  }
  function syncSize() {
    const kind = sizeKind(options.getTool());
    delete widthBtn.dataset.i18nTitle;
    delete widthBtn.dataset.i18nAriaLabel;
    widthBtn.title = t("shot.sizeValue", { name: t(SIZE_LABELS[kind]), value: options.getSize() });
    widthBtn.ariaLabel = widthBtn.title;
    sizeIcon.innerHTML = svgIcon(
      kind === "fontSize" ? "text" : kind === "blockSize" ? "mosaic" : "width",
    );
    sizeValue.textContent = String(options.getSize());
    sizeHeading.dataset.i18n = SIZE_LABELS[kind];
    sizeHeading.textContent = t(SIZE_LABELS[kind]);
    widthList.replaceChildren();
    for (const size of SIZE_PRESETS[kind]) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row";
      row.setAttribute("aria-pressed", String(size === options.getSize()));
      row.textContent = `${size} px`;
      row.addEventListener("mousedown", stopMouseDown);
      row.addEventListener("click", () => {
        options.onSizeChange(size);
        closePopups();
      });
      widthList.appendChild(row);
    }
  }
  syncColor(options.color);
  syncSize();
  return {
    toolbar,
    toolBtns,
    ocrButton: ocr,
    colorBtn,
    widthBtn,
    colorPopup,
    widthPopup,
    closePopups,
    setActionBusy,
    syncColor,
    syncSize,
  };
}

import type { Tool } from "./geometry";
import { makeBtn } from "./icons";

export interface ToolbarOptions {
  uiLayer: HTMLElement;
  color: string;
  strokeWidth: number;
  getTool: () => Tool | null;
  onToolChange: (tool: Tool | null) => void;
  onOcr: () => void;
  onReselect: () => void;
  onCancel: () => void;
  onExport: (action: "clipboard" | "save" | "open") => void;
  onShare: () => void;
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (width: number) => void;
}

export interface ToolbarUi {
  toolbar: HTMLDivElement;
  toolBtns: Map<Tool, HTMLButtonElement>;
  colorBtn: HTMLButtonElement;
  widthBtn: HTMLButtonElement;
  colorPopup: HTMLDivElement;
  widthPopup: HTMLDivElement;
  closePopups(): void;
  syncColor(color: string): void;
  syncStrokeWidth(width: number): void;
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
  const widthDot = document.createElement("div");
  widthDot.className = "width-dot";
  widthBtn.replaceChildren(widthDot);
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
  const widthList = document.createElement("div");
  widthList.className = "width-list";
  for (const width of [2, 4, 6, 10]) {
    const row = document.createElement("div");
    row.className = "row";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = `${width * 3}px`;
    bar.style.height = `${Math.min(12, 2 + width)}px`;
    row.append(bar, document.createTextNode(`${width} px`));
    row.addEventListener("click", () => {
      options.onStrokeWidthChange(width);
      closePopups();
    });
    widthList.appendChild(row);
  }
  widthPopup.appendChild(widthList);
  options.uiLayer.append(toolbar, colorPopup, widthPopup);

  function closePopups() {
    colorPopup.classList.remove("open");
    widthPopup.classList.remove("open");
  }
  function syncColor(color: string) {
    colorSwatch.style.background = color;
    native.value = color;
    colorPopup.querySelectorAll(".cell").forEach((cell) => {
      cell.classList.toggle("sel", (cell as HTMLElement).style.background === color);
    });
  }
  function syncStrokeWidth(width: number) {
    const size = `${Math.min(14, 4 + width * 2)}px`;
    widthDot.style.width = size;
    widthDot.style.height = size;
  }
  syncColor(options.color);
  syncStrokeWidth(options.strokeWidth);
  return {
    toolbar,
    toolBtns,
    colorBtn,
    widthBtn,
    colorPopup,
    widthPopup,
    closePopups,
    syncColor,
    syncStrokeWidth,
  };
}

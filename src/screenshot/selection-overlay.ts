import type { Rect } from "./geometry";

interface SelectionOverlayOptions {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  getViewport: () => { width: number; height: number };
}

/** 选区几何独立于底图；框选时只更新遮罩、边框和标签。 */
export function createSelectionOverlay({ root, canvas, getViewport }: SelectionOverlayOptions) {
  const element = document.createElement("div");
  element.className = "screenshot-selection-overlay";
  element.ariaHidden = "true";
  element.hidden = true;
  const masks = Array.from({ length: 4 }, () => {
    const mask = document.createElement("div");
    mask.className = "screenshot-selection-mask";
    element.append(mask);
    return mask;
  });
  const frame = document.createElement("div");
  frame.className = "screenshot-selection-frame";
  const border = document.createElement("div");
  border.className = "screenshot-selection-border";
  frame.append(border);
  const handles = document.createElement("div");
  for (const direction of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    const handle = document.createElement("i");
    handle.className = `screenshot-selection-handle selection-${direction}`;
    handles.append(handle);
  }
  const label = document.createElement("span");
  label.className = "screenshot-selection-label";
  frame.append(handles, label);
  element.append(frame);
  root.append(element);
  let previous = "";
  const hide = () => {
    element.hidden = true;
    canvas.style.clipPath = "";
    previous = "";
  };
  const update = (selection: Rect | null, hover: Rect | null) => {
    const rect = selection ?? hover;
    if (!rect || rect.w <= 0 || rect.h <= 0 || canvas.width <= 0 || canvas.height <= 0) {
      if (previous) hide();
      return;
    }
    const { width, height } = getViewport();
    const key = `${selection ? "select" : "hover"},${rect.x},${rect.y},${rect.w},${rect.h},${width},${height},${canvas.width},${canvas.height}`;
    if (key === previous) return;
    previous = key;
    const sx = width / canvas.width,
      sy = height / canvas.height;
    const x = Math.max(0, Math.min(width, rect.x * sx)),
      y = Math.max(0, Math.min(height, rect.y * sy));
    const right = Math.max(x, Math.min(width, (rect.x + rect.w) * sx)),
      bottom = Math.max(y, Math.min(height, (rect.y + rect.h) * sy));
    element.hidden = false;
    const regions = [
      { x: 0, y: 0, w: width, h: y },
      { x: 0, y: bottom, w: width, h: height - bottom },
      { x: 0, y, w: x, h: bottom - y },
      { x: right, y, w: width - right, h: bottom - y },
    ];
    masks.forEach((mask, index) => {
      mask.hidden = !selection;
      const area = regions[index];
      mask.style.transform = `translate(${area.x}px, ${area.y}px) scale(${area.w}, ${area.h})`;
    });
    frame.style.transform = `translate(${x}px, ${y}px)`;
    frame.style.width = `${right - x}px`;
    frame.style.height = `${bottom - y}px`;
    handles.hidden = right - x <= 24 || bottom - y <= 24;
    const text = `${Math.round(rect.w)}x${Math.round(rect.h)}`;
    if (label.textContent !== text) label.textContent = text;
    canvas.style.clipPath = selection
      ? `inset(${(y / height) * 100}% ${((width - right) / width) * 100}% ${((height - bottom) / height) * 100}% ${(x / width) * 100}%)`
      : "";
  };
  return { update, hide, element };
}

import { save } from "@tauri-apps/plugin-dialog";
import type { EditedImageFormat, ImageEntry } from "../api";
import { drawAnnotation } from "../image-editor/annotation-renderer";
import {
  cloneShape,
  isShapeHit,
  normRect,
  shapeBBox,
  type Pt,
  type Rect,
  type Shape,
  type Tool,
} from "../image-editor/geometry";
import { SnapshotHistory } from "../image-editor/history";
import {
  createCanvasMosaicRenderer,
  mosaicBlockSize,
} from "../image-editor/canvas-mosaic-renderer";

type EditorTool = Tool | "select" | "crop";

interface EditSnapshot {
  shapes: Shape[];
  crop: Rect | null;
  rotation: number;
}

const ICONS: Record<string, string> = {
  "editor.select": '<path d="m5 3 14 9-7 2-3 7Z"/>',
  "editor.crop": '<path d="M5 3v13a3 3 0 0 0 3 3h13"/><path d="M19 21V8a3 3 0 0 0-3-3H3"/>',
  "editor.rotate":
    '<path fill="currentColor" stroke="none" d="m15.5 5.5-4.5-4.5v3.1A8 8 0 1 0 19.7 14h-2.1A6 6 0 1 1 11 6.1V10z"/>',
  "shot.rect": '<rect x="4" y="5" width="16" height="14" rx="2"/>',
  "shot.circle": '<circle cx="12" cy="12" r="7.5"/>',
  "shot.arrow": '<path d="M5 19 19 5M13 5h6v6"/>',
  "shot.pen": '<path d="M4 19Q6 7 8.5 13T12 12t3.5 1T20 5"/>',
  "shot.mosaic":
    '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  "shot.text": '<path d="M5 5V3h14v2M12 3v18"/>',
  "editor.undo": '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6"/>',
  "editor.redo": '<path d="m15 7 5 5-5 5"/><path d="M20 12H10a6 6 0 0 0-6 6"/>',
  "editor.saveAs":
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  "editor.overwrite": '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3M8 21v-7h8v7"/>',
  "editor.cancel": '<path d="m6 6 12 12M18 6 6 18"/>',
};

function iconFor(key: string) {
  const path = ICONS[key] || "";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

interface ImageEditorControllerOptions {
  root: HTMLElement;
  getEditableSource: (path: string) => Promise<string>;
  saveImage: (path: string, png: string, format: EditedImageFormat) => Promise<void>;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
  onSaved: (path: string) => void;
  toast: (message: string, type?: "success" | "error") => void;
}

function canvasPng(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("Canvas export failed"));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }, "image/png"),
  );
}

/** Owns a non-destructive, canvas-based editor for a single viewer image. */
export function createImageEditorController(options: ImageEditorControllerOptions) {
  const controls = document.createElement("header");
  controls.className = "image-editor-controls";
  const workspace = document.createElement("div");
  workspace.className = "image-editor-workspace";
  const canvas = document.createElement("canvas");
  canvas.className = "image-editor-canvas";
  const textInput = document.createElement("textarea");
  textInput.className = "image-editor-text-input hidden";
  textInput.rows = 2;
  workspace.append(canvas, controls, textInput);
  options.root.replaceChildren(workspace);

  const buttons = new Map<string, HTMLButtonElement>();
  const makeButton = (key: string, action: () => void, parent = controls) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.key = key;
    button.innerHTML = iconFor(key);
    button.addEventListener("click", action);
    buttons.set(key, button);
    parent.appendChild(button);
    return button;
  };
  const toolButton = (key: string, tool: EditorTool) => makeButton(key, () => setTool(tool));

  toolButton("editor.select", "select");
  toolButton("editor.crop", "crop");
  makeButton("editor.rotate", () => rotate());
  controls.appendChild(document.createElement("span")).className = "image-editor-divider";
  toolButton("shot.rect", "rect");
  toolButton("shot.circle", "circle");
  toolButton("shot.arrow", "arrow");
  toolButton("shot.pen", "pen");
  toolButton("shot.mosaic", "mosaic");
  toolButton("shot.text", "text");
  controls.appendChild(document.createElement("span")).className = "image-editor-divider";
  makeButton("editor.undo", () => undo());
  makeButton("editor.redo", () => redo());

  const color = document.createElement("input");
  color.type = "color";
  color.value = "#ff0000";
  color.className = "image-editor-color";
  color.title = options.translate("shot.color");
  controls.appendChild(color);
  const width = document.createElement("select");
  width.className = "image-editor-select";
  [2, 4, 6, 10].forEach((value) => {
    width.append(new Option(`${value}px`, String(value), value === 4, value === 4));
  });
  width.title = options.translate("shot.width");
  controls.appendChild(width);
  const format = document.createElement("select");
  format.className = "image-editor-select";
  ["png", "jpeg", "webp"].forEach((value) => {
    format.append(new Option(value.toUpperCase(), value));
  });
  controls.appendChild(format);
  const outputScale = document.createElement("select");
  outputScale.className = "image-editor-select";
  [100, 75, 50, 25].forEach((value) => {
    outputScale.append(new Option(`${value}%`, String(value)));
  });
  outputScale.title = options.translate("editor.scale");
  controls.appendChild(outputScale);
  controls.appendChild(document.createElement("span")).className = "image-editor-divider";
  makeButton("editor.saveAs", () => void saveAs());
  makeButton("editor.overwrite", () => void overwrite());
  makeButton("editor.cancel", () => close());

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const sourceCanvas = document.createElement("canvas");
  const sourceContext = sourceCanvas.getContext("2d");
  const annotationCanvas = document.createElement("canvas");
  const annotationContext = annotationCanvas.getContext("2d");
  const activeMosaicCanvas = document.createElement("canvas");
  const activeMosaicContext = activeMosaicCanvas.getContext("2d");
  if (!sourceContext || !annotationContext || !activeMosaicContext)
    throw new Error("Canvas 2D is unavailable");
  const mosaicRenderer = createCanvasMosaicRenderer(sourceCanvas);

  let entry: ImageEntry | null = null;
  let image: HTMLImageElement | null = null;
  let tool: EditorTool = "select";
  let shapes: Shape[] = [];
  let current: Shape | null = null;
  let selectedIndex: number | null = null;
  let crop: Rect | null = null;
  let cropStart: Pt | null = null;
  let cropSnapshot: EditSnapshot | null = null;
  let textStart: Pt | null = null;
  let rotation = 0;
  let activeMosaicPoint: Pt | null = null;
  let dragging = false;
  let dirty = false;
  const cloneSnapshot = (value: EditSnapshot): EditSnapshot => ({
    shapes: value.shapes.map(cloneShape),
    crop: value.crop && { ...value.crop },
    rotation: value.rotation,
  });
  const history = new SnapshotHistory<EditSnapshot>(cloneSnapshot);
  const snapshot = (): EditSnapshot => cloneSnapshot({ shapes, crop, rotation });
  const checkpoint = () => history.checkpoint(snapshot());
  const restore = (value: EditSnapshot) => {
    shapes = value.shapes;
    crop = value.crop;
    rotation = value.rotation;
    selectedIndex = null;
    rebuildSource();
    rasterizeAnnotations();
  };

  const translate = () => {
    buttons.forEach((button, key) => {
      button.title = options.translate(key);
      button.ariaLabel = options.translate(key);
    });
    color.title = options.translate("shot.color");
    width.title = options.translate("shot.width");
    outputScale.title = options.translate("editor.scale");
  };

  const displayPoint = (event: PointerEvent): Pt => {
    const box = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - box.left) * (canvas.width / box.width),
      y: (event.clientY - box.top) * (canvas.height / box.height),
    };
  };

  const rebuildSource = () => {
    if (!image) return;
    const quarterTurns = rotation % 180 !== 0;
    sourceCanvas.width = quarterTurns ? image.naturalHeight : image.naturalWidth;
    sourceCanvas.height = quarterTurns ? image.naturalWidth : image.naturalHeight;
    sourceContext.setTransform(1, 0, 0, 1, 0, 0);
    sourceContext.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    sourceContext.translate(sourceCanvas.width / 2, sourceCanvas.height / 2);
    sourceContext.rotate((rotation * Math.PI) / 180);
    sourceContext.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    resetActiveMosaic();
  };

  const resetActiveMosaic = () => {
    activeMosaicCanvas.width = sourceCanvas.width;
    activeMosaicCanvas.height = sourceCanvas.height;
    activeMosaicPoint = null;
  };

  const drawShape = (target: CanvasRenderingContext2D, shape: Shape) => {
    if (shape.tool === "mosaic") mosaicRenderer.drawShape(target, shape);
    else drawAnnotation(target, shape);
  };
  const drawCurrent = (target: CanvasRenderingContext2D) => {
    if (!current) return;
    if (current.tool === "mosaic") target.drawImage(activeMosaicCanvas, 0, 0);
    else drawShape(target, current);
  };
  const rasterizeAnnotations = () => {
    annotationCanvas.width = sourceCanvas.width;
    annotationCanvas.height = sourceCanvas.height;
    annotationContext.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
    shapes.forEach((shape) => {
      drawShape(annotationContext, shape);
    });
  };

  const render = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sourceCanvas, 0, 0);
    context.drawImage(annotationCanvas, 0, 0);
    drawCurrent(context);
    if (crop && crop.w > 1 && crop.h > 1) {
      context.fillStyle = "rgba(0, 0, 0, 0.45)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.save();
      context.beginPath();
      context.rect(crop.x, crop.y, crop.w, crop.h);
      context.clip();
      context.drawImage(sourceCanvas, 0, 0);
      context.drawImage(annotationCanvas, 0, 0);
      drawCurrent(context);
      context.restore();
      context.strokeStyle = "#3fa9f5";
      context.lineWidth = Math.max(1, canvas.width / Math.max(canvas.clientWidth, 1));
      context.strokeRect(crop.x, crop.y, crop.w, crop.h);
    }
    if (selectedIndex !== null && shapes[selectedIndex]) {
      const box = shapeBBox(shapes[selectedIndex]);
      context.strokeStyle = "#3fa9f5";
      context.lineWidth = 2;
      context.strokeRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
    }
  };

  const hideTextInput = () => {
    textStart = null;
    textInput.value = "";
    textInput.classList.add("hidden");
  };
  const commitTextInput = () => {
    const text = textInput.value.trim();
    if (textStart && text) {
      checkpoint();
      shapes.push({
        tool: "text",
        start: textStart,
        end: textStart,
        color: color.value,
        strokeWidth: Number(width.value),
        text,
      });
      rasterizeAnnotations();
      dirty = true;
      render();
    }
    hideTextInput();
  };
  const beginTextInput = (point: Pt) => {
    const canvasBox = canvas.getBoundingClientRect();
    const workspaceBox = workspace.getBoundingClientRect();
    textStart = point;
    textInput.value = "";
    textInput.style.left = `${canvasBox.left - workspaceBox.left + workspace.scrollLeft + 8}px`;
    textInput.style.top = `${canvasBox.top - workspaceBox.top + workspace.scrollTop + 8}px`;
    textInput.classList.remove("hidden");
    textInput.focus();
  };
  textInput.addEventListener("blur", commitTextInput);
  textInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      hideTextInput();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      textInput.blur();
    }
  });

  const setTool = (next: EditorTool) => {
    if (tool === next && next === "crop") crop = null;
    tool = next;
    canvas.style.cursor = next === "select" ? "default" : "crosshair";
    current = null;
    resetActiveMosaic();
    selectedIndex = null;
    buttons.forEach((button, key) => {
      button.classList.toggle("active", key === `editor.${next}` || key === `shot.${next}`);
    });
    render();
  };

  const transformPoint = (point: Pt, oldHeight: number): Pt => ({
    x: oldHeight - point.y,
    y: point.x,
  });

  const transformAnnotations = () => {
    const oldHeight = sourceCanvas.height;
    const transformShape = (shape: Shape) => ({
      ...shape,
      start: transformPoint(shape.start, oldHeight),
      end: transformPoint(shape.end, oldHeight),
      points: shape.points?.map((point) => transformPoint(point, oldHeight)),
    });
    shapes = shapes.map(transformShape);
    if (crop) {
      const corners = [
        transformPoint({ x: crop.x, y: crop.y }, oldHeight),
        transformPoint({ x: crop.x + crop.w, y: crop.y + crop.h }, oldHeight),
      ];
      crop = normRect(corners[0], corners[1]);
    }
  };

  const rotate = () => {
    checkpoint();
    transformAnnotations();
    rotation = (rotation + 90) % 360;
    rebuildSource();
    rasterizeAnnotations();
    dirty = true;
    render();
  };

  const undo = () => {
    const previous = history.undo(snapshot());
    if (!previous) return;
    restore(previous);
    dirty = true;
    render();
  };
  const redo = () => {
    const next = history.redo(snapshot());
    if (!next) return;
    restore(next);
    dirty = true;
    render();
  };

  const exportCanvas = () => {
    const bounds =
      crop && crop.w > 1 && crop.h > 1
        ? crop
        : { x: 0, y: 0, w: sourceCanvas.width, h: sourceCanvas.height };
    const output = document.createElement("canvas");
    output.width = Math.round(bounds.w);
    output.height = Math.round(bounds.h);
    const target = output.getContext("2d");
    if (!target) throw new Error("Canvas 2D is unavailable");
    target.drawImage(
      sourceCanvas,
      bounds.x,
      bounds.y,
      bounds.w,
      bounds.h,
      0,
      0,
      output.width,
      output.height,
    );
    target.save();
    target.translate(-bounds.x, -bounds.y);
    shapes.forEach((shape) => {
      drawShape(target, shape);
    });
    target.restore();
    const ratio = Number(outputScale.value) / 100;
    if (ratio === 1) return output;
    const scaled = document.createElement("canvas");
    scaled.width = Math.max(1, Math.round(output.width * ratio));
    scaled.height = Math.max(1, Math.round(output.height * ratio));
    const scaledContext = scaled.getContext("2d");
    if (!scaledContext) throw new Error("Canvas 2D is unavailable");
    scaledContext.imageSmoothingEnabled = true;
    scaledContext.drawImage(output, 0, 0, scaled.width, scaled.height);
    return scaled;
  };

  const selectedFormat = () => format.value as EditedImageFormat;
  const saveTo = async (path: string, outputFormat = selectedFormat()) => {
    await options.saveImage(path, await canvasPng(exportCanvas()), outputFormat);
    dirty = false;
    options.onSaved(path);
    options.toast(options.translate("editor.saved"), "success");
  };
  const saveAs = async () => {
    if (!entry) return;
    const suffix = selectedFormat();
    const name = `${entry.name.replace(/\.[^.]+$/, "")}_edited.${suffix === "jpeg" ? "jpg" : suffix}`;
    const path = await save({
      defaultPath: name,
      filters: [{ name: suffix.toUpperCase(), extensions: [suffix === "jpeg" ? "jpg" : suffix] }],
    });
    if (!path) return;
    try {
      await saveTo(path);
    } catch (error) {
      options.toast(options.translate("editor.saveFailed", { msg: String(error) }), "error");
    }
  };
  const overwrite = async () => {
    if (
      !entry ||
      !window.confirm(options.translate("editor.overwriteConfirm", { name: entry.name }))
    )
      return;
    const extension = entry.name.split(".").pop()?.toLowerCase();
    const sourceFormat: EditedImageFormat | null =
      extension === "png"
        ? "png"
        : extension === "jpg" || extension === "jpeg"
          ? "jpeg"
          : extension === "webp"
            ? "webp"
            : null;
    if (!sourceFormat) {
      options.toast(options.translate("editor.overwriteUnsupported"), "error");
      return;
    }
    try {
      await saveTo(entry.path, sourceFormat);
    } catch (error) {
      options.toast(options.translate("editor.saveFailed", { msg: String(error) }), "error");
    }
  };

  const close = () => {
    commitTextInput();
    if (dirty && !window.confirm(options.translate("editor.discardConfirm"))) return;
    options.root.classList.add("hidden");
    options.onClose();
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (!image || event.button !== 0) return;
    const point = displayPoint(event);
    canvas.setPointerCapture(event.pointerId);
    if (tool === "crop") {
      cropSnapshot = snapshot();
      cropStart = point;
      crop = { x: point.x, y: point.y, w: 0, h: 0 };
      dragging = true;
      render();
      return;
    }
    if (tool === "select") {
      selectedIndex =
        shapes
          .map((shape, index) => ({ shape, index }))
          .reverse()
          .find(({ shape }) => isShapeHit(shape, point, 10))?.index ?? null;
      render();
      return;
    }
    if (tool === "text") {
      beginTextInput(point);
      return;
    }
    current = {
      tool,
      start: point,
      end: point,
      color: color.value,
      strokeWidth: Number(width.value),
      points: tool === "pen" || tool === "mosaic" ? [point] : undefined,
    };
    dragging = true;
    if (tool === "mosaic") {
      resetActiveMosaic();
      activeMosaicPoint = point;
      mosaicRenderer.drawSegment(activeMosaicContext, point, point, mosaicBlockSize(current));
      render();
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const point = displayPoint(event);
    if (tool === "crop" && cropStart) crop = normRect(cropStart, point);
    else if (current) {
      current.end = point;
      if (current.points) {
        const previous = current.points[current.points.length - 1];
        if (current.tool === "mosaic" && activeMosaicPoint) {
          mosaicRenderer.drawSegment(
            activeMosaicContext,
            activeMosaicPoint,
            point,
            mosaicBlockSize(current),
          );
          activeMosaicPoint = point;
        }
        const minDistance = current.tool === "mosaic" ? 2 : 1;
        if (Math.hypot(point.x - previous.x, point.y - previous.y) >= minDistance) {
          current.points.push(point);
        }
      }
    }
    render();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (tool === "crop") {
      cropStart = null;
      if (crop && (crop.w < 2 || crop.h < 2)) crop = cropSnapshot?.crop ?? null;
      else if (cropSnapshot) {
        history.checkpoint(cropSnapshot);
        dirty = true;
      }
      cropSnapshot = null;
    } else if (current) {
      if (current.points) {
        const point = displayPoint(event);
        const previous = current.points[current.points.length - 1];
        if (current.tool === "mosaic" && activeMosaicPoint) {
          mosaicRenderer.drawSegment(
            activeMosaicContext,
            activeMosaicPoint,
            point,
            mosaicBlockSize(current),
          );
        }
        if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0) current.points.push(point);
      }
      if (
        Math.abs(current.end.x - current.start.x) > 1 ||
        Math.abs(current.end.y - current.start.y) > 1
      ) {
        checkpoint();
        shapes.push(current);
        rasterizeAnnotations();
        dirty = true;
      }
      current = null;
      resetActiveMosaic();
    }
    render();
  });
  window.addEventListener("keydown", (event) => {
    if (options.root.classList.contains("hidden")) return;
    if (event.ctrlKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
    } else if (event.ctrlKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    } else if (event.key === "Delete" && selectedIndex !== null) {
      checkpoint();
      shapes.splice(selectedIndex, 1);
      rasterizeAnnotations();
      selectedIndex = null;
      dirty = true;
      render();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });

  const open = async (nextEntry: ImageEntry) => {
    entry = nextEntry;
    options.root.classList.remove("hidden");
    translate();
    const nextImage = new Image();
    nextImage.src = await options.getEditableSource(nextEntry.path);
    await nextImage.decode();
    image = nextImage;
    shapes = [];
    current = null;
    selectedIndex = null;
    crop = null;
    cropSnapshot = null;
    hideTextInput();
    rotation = 0;
    dirty = false;
    history.clear();
    rebuildSource();
    rasterizeAnnotations();
    setTool("select");
    render();
  };

  return {
    open,
    close,
    isOpen: () => !options.root.classList.contains("hidden"),
    refreshTranslations: translate,
  };
}

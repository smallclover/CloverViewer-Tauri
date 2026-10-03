import { save } from "@tauri-apps/plugin-dialog";
import type { EditedImageFormat, ImageEntry } from "../api";
import { createAnnotationLayers } from "../image-editor/annotation-layers";
import { drawAnnotation } from "../image-editor/annotation-renderer";
import { annotationFont } from "../image-editor/annotation-style";
import {
  createCanvasMosaicRenderer,
  mosaicBlockSize,
} from "../image-editor/canvas-mosaic-renderer";
import { createCropOverlay } from "../image-editor/crop-overlay";
import { createFrameUpdate } from "../image-editor/frame-update";
import {
  cloneShape,
  isShapeHit,
  normRect,
  type Pt,
  type Rect,
  type Shape,
  shapeBBox,
} from "../image-editor/geometry";
import { SnapshotHistory } from "../image-editor/history";
import { createMosaicCursor } from "../image-editor/mosaic-cursor";
import { createEditorToolbar, type EditorTool } from "../image-editor/toolbar";
import { createImageEditorLoader } from "./image-editor-loader";

interface EditSnapshot {
  shapes: Shape[];
  crop: Rect | null;
  rotation: number;
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

/** 单张查看器图像的编辑器：基于 canvas 绘制，标注过程不破坏原图（可随时撤销）。 */
export function createImageEditorController(options: ImageEditorControllerOptions) {
  const loader = createImageEditorLoader({ getSource: options.getEditableSource });
  const workspace = document.createElement("div");
  workspace.className = "image-editor-workspace";
  const canvas = document.createElement("canvas");
  canvas.className = "image-editor-canvas";
  const textInput = document.createElement("textarea");
  textInput.className = "image-editor-text-input annotation-text-input hidden";
  textInput.rows = 1;
  textInput.wrap = "off";
  textInput.spellcheck = false;
  const textFrame = document.createElement("div");
  textFrame.className = "image-editor-text-frame annotation-text-frame hidden";
  textFrame.ariaHidden = "true";
  for (const position of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    const corner = document.createElement("span");
    corner.className = `annotation-text-corner ${position}`;
    textFrame.append(corner);
  }
  workspace.append(canvas, textInput, textFrame);
  options.root.replaceChildren(workspace);
  const toolbar = createEditorToolbar({
    workspace,
    translate: options.translate,
    setTool: (next) => setTool(next),
    rotate: () => rotate(),
    undo: () => undo(),
    redo: () => redo(),
    saveAs: () => void saveAs(),
    overwrite: () => void overwrite(),
    close: () => close(),
  });
  const { color, sizes, format, outputScale } = toolbar;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const sourceCanvas = document.createElement("canvas");
  const sourceContext = sourceCanvas.getContext("2d");
  if (!sourceContext) throw new Error("Canvas 2D is unavailable");
  const mosaicRenderer = createCanvasMosaicRenderer(sourceCanvas);
  const layers = createAnnotationLayers({
    getSize: () => ({ width: sourceCanvas.width, height: sourceCanvas.height }),
    drawShape: (target, shape) => drawShape(target, shape),
    drawMosaicSegment: mosaicRenderer.drawSegment,
  });

  let entry: ImageEntry | null = null;
  let image: HTMLImageElement | null = null;
  let tool: EditorTool = "select";
  let shapes: Shape[] = [];
  let current: Shape | null = null;
  let selectedIndex: number | null = null;
  let crop: Rect | null = null;
  let cropSnapshot: EditSnapshot | null = null;
  let textStart: Pt | null = null;
  let textStyle = { color: color.value, fontSize: sizes.fontSize };
  let rotation = 0;
  let repaint = true;
  let dragging = false;
  let dirty = false;
  const mosaicCursor = createMosaicCursor({
    surface: canvas,
    layer: workspace,
    getSize: () => (current?.tool === "mosaic" ? mosaicBlockSize(current) : sizes.blockSize),
    isEnabled: () => !!image && tool === "mosaic" && !options.root.classList.contains("hidden"),
  });
  toolbar.width.addEventListener("change", mosaicCursor.refresh);
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
    toolbar.refreshTranslations();
    textInput.ariaLabel = options.translate("editor.textPrompt");
    textInput.placeholder = textInput.ariaLabel;
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
    mosaicRenderer.reset();
    layers.reset();
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    resetActiveMosaic();
  };

  const resetActiveMosaic = () => {
    layers.update(shapes, null);
    repaint = true;
  };

  const drawShape = (target: CanvasRenderingContext2D, shape: Shape) => {
    if (shape.tool === "mosaic") mosaicRenderer.drawShape(target, shape);
    else drawAnnotation(target, shape);
  };
  const rasterizeAnnotations = () => {
    layers.update(shapes, null);
    repaint = true;
  };

  const render = () => {
    const damage = layers.update(shapes, current);
    const full = repaint || tool === "crop" || selectedIndex !== null || damage === "full";
    repaint = false;
    if (!full && !damage) return;
    const area = !full && damage ? damage : { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const x = Math.max(0, area.x),
      y = Math.max(0, area.y);
    const w = Math.min(canvas.width, area.x + area.w) - x;
    const h = Math.min(canvas.height, area.y + area.h) - y;
    if (w <= 0 || h <= 0) return;
    context.save();
    context.beginPath();
    context.rect(x, y, w, h);
    context.clip();
    context.clearRect(x, y, w, h);
    context.drawImage(sourceCanvas, x, y, w, h, x, y, w, h);
    layers.paint(context, { x, y, w, h });
    if (selectedIndex !== null && shapes[selectedIndex]) {
      const box = shapeBBox(shapes[selectedIndex]);
      context.strokeStyle = "#3fa9f5";
      context.lineWidth = 2;
      context.strokeRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
    }
    context.restore();
    if (tool === "crop") cropOverlay.refreshImage();
    toolbar.refreshHistory(history.canUndo, history.canRedo);
  };

  const paint = createFrameUpdate(() => render());

  const cropOverlay = createCropOverlay({
    canvas,
    workspace,
    getCrop: () => crop,
    isActive: () => tool === "crop",
    onBegin: () => {
      cropSnapshot = snapshot();
    },
    onChange: (next) => {
      crop = next;
      cropOverlay.update();
    },
    onEnd: (cancelled) => {
      if (!cropSnapshot) return;
      if (cancelled || !crop || crop.w < 2 || crop.h < 2) crop = cropSnapshot.crop;
      else {
        const previous = cropSnapshot.crop ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
        if (
          crop.x !== previous.x ||
          crop.y !== previous.y ||
          crop.w !== previous.w ||
          crop.h !== previous.h
        ) {
          history.checkpoint(cropSnapshot);
          dirty = true;
        }
      }
      cropSnapshot = null;
      cropOverlay.update();
      toolbar.refreshHistory(history.canUndo, history.canRedo);
    },
  });

  const hideTextInput = () => {
    textStart = null;
    textInput.value = "";
    textInput.classList.add("hidden");
    textInput.classList.remove("editing");
    textFrame.classList.add("hidden");
  };
  const commitTextInput = () => {
    const text = textInput.value.trim();
    if (textStart && text) {
      checkpoint();
      context.font = annotationFont(textStyle.fontSize);
      const lines = text.split("\n");
      const textWidth = Math.max(...lines.map((line) => context.measureText(line).width));
      shapes.push({
        tool: "text",
        start: textStart,
        end: {
          x: textStart.x + textWidth,
          y: textStart.y + lines.length * textStyle.fontSize * 1.2,
        },
        color: textStyle.color,
        strokeWidth: sizes.strokeWidth,
        fontSize: textStyle.fontSize,
        text,
      });
      rasterizeAnnotations();
      dirty = true;
      render();
    }
    hideTextInput();
  };
  const layoutTextInput = () => {
    if (!textStart) return;
    const canvasBox = canvas.getBoundingClientRect();
    const workspaceBox = workspace.getBoundingClientRect();
    const scale = canvasBox.width / canvas.width;
    if (scale <= 0) return;
    const fontSize = textStyle.fontSize * scale;
    const lineHeight = fontSize * 1.2;
    // 1px 边框 + 8px/6px 内边距；输入文字与 Canvas 的起点保持一致。
    const insetX = 9;
    const insetY = 7;
    const defaultWidth = 180;
    const defaultHeight = Math.max(44, lineHeight + insetY * 2);
    const x = canvasBox.left - workspaceBox.left + textStart.x * scale;
    const y = canvasBox.top - workspaceBox.top + textStart.y * scale;
    const left = Math.max(4, Math.min(x - insetX, workspaceBox.width - defaultWidth - 8));
    const top = Math.max(4, Math.min(y - insetY, workspaceBox.height - defaultHeight - 8));
    textStart.x = (workspaceBox.left + left + insetX - canvasBox.left) / scale;
    textStart.y = (workspaceBox.top + top + insetY - canvasBox.top) / scale;
    const lines = textInput.value.split("\n");
    context.font = annotationFont(textStyle.fontSize);
    const textWidth = Math.max(...lines.map((line) => context.measureText(line).width)) * scale;
    const maxWidth = Math.max(1, workspaceBox.width - left - 8);
    const maxHeight = Math.max(1, workspaceBox.height - top - 8);
    const width = Math.min(Math.max(defaultWidth, textWidth + insetX * 2), maxWidth);
    textInput.style.font = annotationFont(fontSize);
    textInput.style.lineHeight = "1.2";
    textInput.style.color = textStyle.color;
    textInput.style.left = `${workspace.scrollLeft + left}px`;
    textInput.style.top = `${workspace.scrollTop + top}px`;
    textInput.style.width = `${width}px`;
    // 横向溢出时也给滚动条留出高度，不让它遮住当前行。
    textInput.style.height = "auto";
    const height = Math.max(
      defaultHeight,
      lines.length * lineHeight + insetY * 2,
      textInput.scrollHeight + 2,
    );
    textInput.style.height = `${Math.min(height, maxHeight)}px`;
    for (const property of ["left", "top", "width", "height"] as const)
      textFrame.style[property] = textInput.style[property];
  };
  const beginTextInput = (point: Pt) => {
    commitTextInput();
    textStart = point;
    textStyle = { color: color.value, fontSize: sizes.fontSize };
    textInput.value = "";
    textInput.classList.remove("hidden");
    textInput.classList.add("editing");
    textFrame.classList.remove("hidden");
    layoutTextInput();
    // pointerdown 的默认动作要先走完，之后 textarea 才能拿到焦点，故延到下一个任务。
    window.setTimeout(() => {
      if (textStart === point) textInput.focus({ preventScroll: true });
    }, 0);
  };
  textInput.addEventListener("input", layoutTextInput);
  window.addEventListener("resize", layoutTextInput);
  textInput.addEventListener("blur", commitTextInput);
  textInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      hideTextInput();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      textInput.blur();
    }
  });

  const setTool = (next: EditorTool) => {
    paint.discard();
    commitTextInput();
    cropOverlay.cancel();
    tool = next;
    canvas.style.cursor = next === "select" ? "default" : "crosshair";
    current = null;
    resetActiveMosaic();
    selectedIndex = null;
    toolbar.setActiveTool(next);
    mosaicCursor.refresh();
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
    cropOverlay.cancel();
    checkpoint();
    transformAnnotations();
    rotation = (rotation + 90) % 360;
    rebuildSource();
    rasterizeAnnotations();
    dirty = true;
    render();
  };

  const undo = () => {
    cropOverlay.cancel();
    const previous = history.undo(snapshot());
    if (!previous) return;
    restore(previous);
    dirty = true;
    render();
  };
  const redo = () => {
    cropOverlay.cancel();
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
    cropOverlay.cancel();
    commitTextInput();
    if (dirty && !window.confirm(options.translate("editor.discardConfirm"))) return;
    loader.cancel();
    paint.discard();
    toolbar.closePanels();
    options.root.classList.add("hidden");
    mosaicCursor.reset();
    options.onClose();
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (!image || event.button !== 0 || tool === "crop") return;
    const point = displayPoint(event);
    if (tool === "text") {
      event.preventDefault();
      beginTextInput(point);
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    if (tool === "select") {
      repaint = true;
      selectedIndex =
        shapes
          .map((shape, index) => ({ shape, index }))
          .reverse()
          .find(({ shape }) => isShapeHit(shape, point, 10))?.index ?? null;
      render();
      return;
    }
    current = {
      tool,
      start: point,
      end: point,
      color: color.value,
      strokeWidth: sizes.strokeWidth,
      blockSize: tool === "mosaic" ? sizes.blockSize : undefined,
      points: tool === "pen" || tool === "mosaic" ? [point] : undefined,
    };
    dragging = true;
    if (tool === "mosaic") {
      resetActiveMosaic();
      render();
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const point = displayPoint(event);
    if (current) {
      current.end = point;
      if (current.points) {
        const previous = current.points[current.points.length - 1];
        const minDistance = current.tool === "mosaic" ? 0 : 1;
        if (Math.hypot(point.x - previous.x, point.y - previous.y) >= minDistance) {
          current.points.push(point);
        }
      }
    }
    paint.push(undefined);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    paint.discard();
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (current) {
      if (current.points) {
        const point = displayPoint(event);
        const previous = current.points[current.points.length - 1];
        current.end = point;
        if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0) current.points.push(point);
      }
      if (
        Math.abs(current.end.x - current.start.x) > 1 ||
        Math.abs(current.end.y - current.start.y) > 1 ||
        ((current.tool === "mosaic" || current.tool === "pen") &&
          (current.points?.length ?? 0) > 1) ||
        current.tool === "mosaic"
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

  const open = async (nextEntry: ImageEntry, onReady: () => void) => {
    const nextImage = await loader.load(nextEntry.path);
    if (!nextImage) return false;
    cropOverlay.cancel();
    entry = nextEntry;
    mosaicCursor.reset();
    translate();
    image = nextImage;
    shapes = [];
    current = null;
    selectedIndex = null;
    crop = null;
    cropSnapshot = null;
    dragging = false;
    hideTextInput();
    rotation = 0;
    dirty = false;
    history.clear();
    rebuildSource();
    rasterizeAnnotations();
    setTool("select");
    // setTool 已在隐藏状态下画好首帧；这里紧接着显形并让查看器一并切走，不留中间态。
    onReady();
    options.root.classList.remove("hidden");
    toolbar.updateLayout();
    toolbar.initializeSizes(canvas.getBoundingClientRect().width / canvas.width);
    cropOverlay.refreshImage();
    return true;
  };

  return {
    open,
    close,
    cancelPendingOpen: loader.cancel,
    isOpening: loader.isLoading,
    isOpen: () => !options.root.classList.contains("hidden"),
    refreshTranslations: translate,
  };
}

import { canvasPng } from "../image-editor/canvas-export";
import { composeEditedImage } from "../image-editor/export-image";
import { createEditorTextInput } from "../image-editor/editor-text-input";
import { createDrawingSession } from "../image-editor/drawing-session";
import { save } from "@tauri-apps/plugin-dialog";
import type {
  BeautifyDocument,
  EditedImageFormat,
  ImageEntry,
  ScreenshotEditContext,
} from "../api";
import { cloneBeauty, emptyBeauty, rebaseBeauty } from "../image-beautify/model";
import { checkBeautySize } from "../image-beautify/layout";
import { createBeautyTransaction } from "../image-beautify/transaction";
import { createAnnotationLayers } from "../image-editor/annotation-layers";
import { createAnnotationSelection } from "../image-editor/annotation-selection";
import { drawAnnotation } from "../image-editor/annotation-renderer";
import { imageAnnotationSizes } from "../image-editor/annotation-style";
import {
  createCanvasMosaicRenderer,
  mosaicBlockSize,
} from "../image-editor/canvas-mosaic-renderer";
import { createCropOverlay } from "../image-editor/crop-overlay";
import { createCropTransaction } from "../image-editor/crop-transaction";
import { createCropViewport } from "../image-editor/crop-viewport";
import { createEditorConfirmDialog } from "../image-editor/confirm-dialog";
import { createFrameUpdate } from "../image-editor/frame-update";
import {
  cloneShape,
  normRect,
  rotateShapeClockwise,
  type Pt,
  type Rect,
  type Shape,
} from "../image-editor/geometry";
import { SnapshotHistory, shapeHistoryBytes } from "../image-editor/history";
import { createMosaicCursor } from "../image-editor/mosaic-cursor";
import { createEditorSaveController } from "../image-editor/save-controller";
import { bindEditorViewportInput } from "../image-editor/viewport-input";
import { createEditorZoomToolbar } from "../image-editor/zoom-toolbar";
import { createEditorToolbar, type EditorTool } from "../image-editor/toolbar";
import { createImageEditorLoader } from "./image-editor-loader";

interface EditSnapshot {
  shapes: Shape[];
  crop: Rect | null;
  rotation: number;
  beauty: BeautifyDocument;
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

/** 单张查看器图像的编辑器：基于 canvas 绘制，标注过程不破坏原图（可随时撤销）。 */
export function createImageEditorController(options: ImageEditorControllerOptions) {
  const loader = createImageEditorLoader({ getSource: options.getEditableSource });
  const workspace = document.createElement("div");
  workspace.className = "image-editor-workspace";
  const canvas = document.createElement("canvas");
  canvas.className = "image-editor-canvas";
  const surface = document.createElement("div");
  surface.className = "image-editor-surface";
  surface.append(canvas);
  const imageBoundary = document.createElement("div");
  imageBoundary.className = "image-editor-boundary";
  imageBoundary.ariaHidden = "true";
  surface.append(imageBoundary);
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
  workspace.append(surface, textInput, textFrame);
  options.root.replaceChildren(workspace);
  const toolbar = createEditorToolbar({
    workspace,
    translate: options.translate,
    setTool: (next) => setTool(next),
    rotate: () => rotate(),
    deleteSelected: () => deleteSelected(),
    applyCrop: () => finishCrop(true),
    cancelCrop: () => finishCrop(false),
    undo: () => undo(),
    redo: () => redo(),
    reset: () => reset(),
    saveAs: () => {
      if (!requireCropResolution() && !saves.isBusy()) {
        finishBeauty();
        void saves.saveAs();
      }
    },
    overwrite: () => {
      if (!requireCropResolution() && !saves.isBusy()) {
        finishBeauty();
        void saves.overwrite();
      }
    },
    close: () => void close(),
    beautify: () => void openBeautify(),
  });
  const confirmDialog = createEditorConfirmDialog({ workspace });
  const zoomToolbar = createEditorZoomToolbar({
    container: toolbar.zoomSlot,
    translate: options.translate,
    zoom: (factor) => cropViewport.zoomBy(factor),
    fit: () => cropViewport.fitImage(),
    actualSize: () => cropViewport.actualSize(),
  });
  const { color, sizes, format, outputScale } = toolbar;
  for (const control of [format, outputScale])
    control.addEventListener?.("change", () => beautyWorkspace?.refresh());
  const drawingSizes = () =>
    imageAnnotationSizes(sizes, canvas.getBoundingClientRect().width / canvas.width);

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
  let crop: Rect | null = null;
  let cropSnapshot: EditSnapshot | null = null;
  let rotation = 0;
  let beauty = emptyBeauty();
  let beautyTime = new Date();
  let beautyOpening = false;
  let beautyWorkspace: ReturnType<
    typeof import("../image-beautify/workspace").createBeautyWorkspace
  > | null = null;
  let repaint = true;
  let session = 0;
  let revision = 0;
  let savedRevision = 0;
  const markDirty = () => {
    revision++;
  };
  let closing = false;
  const mosaicCursor = createMosaicCursor({
    surface: canvas,
    layer: workspace,
    getSize: () =>
      drawing.current?.tool === "mosaic"
        ? mosaicBlockSize(drawing.current)
        : drawingSizes().blockSize,
    isEnabled: () => !!image && tool === "mosaic" && !options.root.classList.contains("hidden"),
  });
  toolbar.width.addEventListener("change", mosaicCursor.refresh);
  const cloneSnapshot = (value: EditSnapshot): EditSnapshot => ({
    shapes: value.shapes.map(cloneShape),
    crop: value.crop && { ...value.crop },
    rotation: value.rotation,
    beauty: cloneBeauty(value.beauty),
  });
  const history = new SnapshotHistory<EditSnapshot>(
    cloneSnapshot,
    (value) => shapeHistoryBytes(value.shapes) + JSON.stringify(value.beauty).length * 2 + 128,
  );
  const snapshot = (): EditSnapshot => ({ shapes, crop, rotation, beauty });
  const checkpoint = () => {
    finishBeauty();
    history.checkpoint(snapshot());
  };
  const restore = (value: EditSnapshot) => {
    shapes = value.shapes;
    crop = value.crop;
    rotation = value.rotation;
    beauty = value.beauty;
    beautyTransaction.clear();
    toolbar.syncBeauty?.(beauty.enabled);
    beautyWorkspace?.sync();
    selection.clear();
    rebuildSource();
    rasterizeAnnotations();
    cropViewport.fit();
  };
  const beautyTransaction = createBeautyTransaction({
    capture: snapshot,
    clone: cloneSnapshot,
    getRevision: () => revision,
    setRevision: (value) => {
      revision = value;
    },
    restoreBeauty: (value) => {
      beauty = value;
    },
    commit: (before) => history.checkpoint(before),
  });
  function refreshHistory() {
    toolbar.refreshHistory(
      beautyTransaction.changed() || history.canUndo,
      !beautyTransaction.changed() && history.canRedo,
    );
  }
  function finishBeauty() {
    beautyWorkspace?.settle();
    beautyTransaction.finish();
    refreshHistory();
    beautyWorkspace?.refreshSession();
  }
  const cropTransaction = createCropTransaction({
    capture: snapshot,
    clone: cloneSnapshot,
    getSize: () => ({ w: canvas.width, h: canvas.height }),
    restore,
    commit: (before) => {
      history.checkpoint(before);
      markDirty();
    },
  });
  const requireCropResolution = () => {
    if (!cropTransaction.active) return false;
    options.toast(options.translate("editor.finishCropFirst"), "error");
    return true;
  };
  const finishCrop = (apply: boolean) => {
    if (!cropTransaction.active) return;
    cropOverlay.cancel();
    cropTransaction.finish(apply);
    setTool("select");
    cropViewport.fit();
    render();
  };

  const translate = () => {
    toolbar.refreshTranslations();
    zoomToolbar.refreshTranslations();
    selection.refreshTranslations();
    textInput.ariaLabel = options.translate("editor.textPrompt");
    textInput.placeholder = textInput.ariaLabel;
    beautyWorkspace?.refreshTranslations();
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
    const damage = layers.update(shapes, drawing.current);
    const full = repaint || tool === "crop" || damage === "full";
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
    context.restore();
    beautyWorkspace?.refresh(true);
    selection.refresh();
    if (tool === "crop") cropOverlay.refreshImage();
    refreshHistory();
  };

  const paint = createFrameUpdate(() => render());
  const selection = createAnnotationSelection({
    canvas,
    surface,
    translate: options.translate,
    isActive: () => tool === "select" && !!image && !options.root.classList.contains("hidden"),
    getShapes: () => shapes,
    getBounds: () => crop ?? { x: 0, y: 0, w: canvas.width, h: canvas.height },
    replace: (index, shape) => {
      finishBeauty();
      shapes[index] = shape;
      repaint = true;
    },
    commit: (index, before) => {
      finishBeauty();
      history.checkpoint({
        ...snapshot(),
        shapes: shapes.map((shape, i) => (i === index ? before : shape)),
      });
      markDirty();
    },
    select: (selected) => toolbar.setSelection(selected),
    render: () => {
      paint.discard();
      render();
    },
  });
  const deleteSelected = () => {
    selection.cancel();
    const index = selection.selected;
    if (index === null) return;
    checkpoint();
    shapes.splice(index, 1);
    selection.clear();
    rasterizeAnnotations();
    markDirty();
    render();
  };
  const drawing = createDrawingSession({
    canvas,
    host: window,
    isEnabled: () => !!image,
    getTool: () => tool,
    getPoint: displayPoint,
    getStyle: () => ({ color: color.value, ...drawingSizes() }),
    requestPaint: () => paint.push(undefined),
    discardPaint: paint.discard,
    invalidate: resetActiveMosaic,
    render,
    commit: (shape) => {
      checkpoint();
      shapes.push(shape);
      rasterizeAnnotations();
      markDirty();
      return shapes.length - 1;
    },
    adjust: (index) => adjustAnnotation(index),
  });
  const cancelDrawing = drawing.cancel;

  const cropViewport = createCropViewport({
    canvas,
    surface,
    getCrop: () => crop,
    getDisplayBounds: () => beautyWorkspace?.bounds() ?? null,
    isCropping: () => tool === "crop",
    onCropChange: (next) => {
      crop = next;
    },
    onLayout: (animating) => {
      const bounds = tool === "crop" ? null : (beautyWorkspace?.bounds() ?? crop);
      const scale = cropViewport.scale();
      Object.assign(imageBoundary.style, {
        left: `${Number.parseFloat(canvas.style.left) + (bounds?.x ?? 0) * scale}px`,
        top: `${Number.parseFloat(canvas.style.top) + (bounds?.y ?? 0) * scale}px`,
        width: `${(bounds?.w ?? canvas.width) * scale}px`,
        height: `${(bounds?.h ?? canvas.height) * scale}px`,
      });
      zoomToolbar.setScale(cropViewport.scale(), {
        canActualSize: cropViewport.canActualSize(),
        cropping: tool === "crop",
      });
      if (animating) cropOverlay.refreshLayout();
      else cropOverlay.refreshImage();
      mosaicCursor.reset();
      selection.refresh();
      textEditor.layout();
      beautyWorkspace?.layout();
    },
  });
  const cropOverlay = createCropOverlay({
    canvas,
    workspace: surface,
    getCrop: () => crop,
    isActive: () => tool === "crop",
    onBegin: () => {
      cropSnapshot = snapshot();
      cropViewport.begin();
    },
    onChange: (next) => {
      crop = next;
      cropOverlay.update();
    },
    onEnd: (cancelled) => {
      if (!cropSnapshot) return;
      if (cancelled || !crop || crop.w < 2 || crop.h < 2) crop = cropSnapshot.crop;
      cropSnapshot = null;
      cropViewport.end(cancelled);
      cropOverlay.update();
      refreshHistory();
    },
  });

  const textEditor = createEditorTextInput({
    input: textInput,
    frame: textFrame,
    workspace,
    canvas,
    context,
    host: window,
    getStyle: () => ({ color: color.value, ...drawingSizes() }),
    onCommit: (shape) => {
      checkpoint();
      shapes.push(shape);
      const added = shapes.length - 1;
      rasterizeAnnotations();
      markDirty();
      render();
      return added;
    },
    onAdjust: (index) => adjustAnnotation(index),
  });
  const viewportInput = bindEditorViewportInput({
    surface,
    viewport: cropViewport,
    isActive: () => !options.root.classList.contains("hidden"),
    isBusy: () =>
      drawing.isDrawing() ||
      selection.isDragging() ||
      !!cropSnapshot ||
      textEditor.isEditing() ||
      !!beautyWorkspace?.isDragging() ||
      confirmDialog.isOpen(),
    isCropping: () => tool === "crop",
  });

  const setTool = (next: EditorTool) => {
    if (next !== "crop" && cropTransaction.active && cropTransaction.changed()) {
      requireCropResolution();
      return;
    }
    if (next !== "select") finishBeauty();
    cancelDrawing();
    selection.clear();
    paint.discard();
    textEditor.commit();
    cropOverlay.cancel();
    if (next !== "crop" && cropTransaction.active) cropTransaction.finish(false);
    if (next === "crop") cropTransaction.begin();
    tool = next;
    if (next !== "crop" && beautyWorkspace?.isOpen())
      beauty = rebaseBeauty(beauty, crop?.w ?? canvas.width, crop?.h ?? canvas.height);
    canvas.style.cursor = next === "select" ? "default" : "crosshair";
    drawing.reset();
    resetActiveMosaic();
    toolbar.setActiveTool(next);
    cropViewport.refresh();
    cropOverlay.update();
    mosaicCursor.refresh();
    render();
    beautyWorkspace?.sync();
  };

  const adjustAnnotation = (index: number) => {
    setTool("select");
    selection.focus(index);
  };

  const transformPoint = (point: Pt, oldHeight: number): Pt => ({
    x: oldHeight - point.y,
    y: point.x,
  });

  const transformAnnotations = () => {
    const oldHeight = sourceCanvas.height;
    shapes = shapes.map((shape) => rotateShapeClockwise(shape, oldHeight));
    if (crop) {
      const corners = [
        transformPoint({ x: crop.x, y: crop.y }, oldHeight),
        transformPoint({ x: crop.x + crop.w, y: crop.y + crop.h }, oldHeight),
      ];
      crop = normRect(corners[0], corners[1]);
    }
  };

  const rotate = () => {
    if (requireCropResolution()) return;
    cancelDrawing();
    selection.clear();
    textEditor.commit();
    cropOverlay.cancel();
    checkpoint();
    transformAnnotations();
    rotation = (rotation + 90) % 360;
    rebuildSource();
    rasterizeAnnotations();
    markDirty();
    render();
    cropViewport.fit();
  };

  const undo = () => {
    if (requireCropResolution()) return;
    cancelDrawing();
    selection.clear();
    cropOverlay.cancel();
    finishBeauty();
    const previous = history.undo(snapshot());
    if (!previous) return;
    restore(previous);
    markDirty();
    render();
  };
  const redo = () => {
    if (requireCropResolution()) return;
    cancelDrawing();
    selection.clear();
    cropOverlay.cancel();
    finishBeauty();
    const next = history.redo(snapshot());
    if (!next) return;
    restore(next);
    markDirty();
    render();
  };
  const reset = () => {
    finishBeauty();
    cancelDrawing();
    selection.clear();
    cropOverlay.cancel();
    if (cropTransaction.active) cropTransaction.finish(false);
    textEditor.commit();
    if (
      shapes.length ||
      crop ||
      rotation !== 0 ||
      beauty.enabled ||
      beauty.watermarks.length ||
      beauty.frame.kind !== "none"
    ) {
      checkpoint();
      shapes = [];
      crop = null;
      rotation = 0;
      beauty = emptyBeauty();
      toolbar.syncBeauty?.(false);
      beautyWorkspace?.sync();
      rebuildSource();
      rasterizeAnnotations();
      markDirty();
    }
    setTool("select");
    cropViewport.fit();
  };

  const exportCanvas = (includeScale = true) => {
    selection.cancel();
    if (cropTransaction.active) throw new Error(options.translate("editor.finishCropFirst"));
    if (beauty.enabled || !includeScale)
      checkBeautySize(crop?.w ?? sourceCanvas.width, crop?.h ?? sourceCanvas.height);
    return composeEditedImage({
      source: sourceCanvas,
      crop,
      shapes,
      scale: includeScale ? Number(outputScale.value) / 100 : 1,
      drawShape,
    });
  };

  const openBeautify = async () => {
    if (!image || beautyOpening || requireCropResolution() || saves.isBusy()) return;
    if (beautyWorkspace?.isOpen()) {
      beautyWorkspace.close();
      return;
    }
    cancelDrawing();
    selection.cancel();
    textEditor.commit();
    toolbar.closePanels();
    setTool("select");
    const current = session;
    beautyOpening = true;
    try {
      const { createBeautyWorkspace } = await import("../image-beautify/workspace");
      if (current !== session) return;
      beauty = rebaseBeauty(beauty, crop?.w ?? canvas.width, crop?.h ?? canvas.height);
      beautyWorkspace ??= createBeautyWorkspace({
        workspace,
        canvas,
        surface,
        t: options.translate,
        getDocument: () => beauty,
        getCrop: () => crop,
        getTime: () => beautyTime,
        getOutputScale: () => Number(outputScale.value) / 100,
        getWhiteBackground: () => format.value === "jpeg",
        isCropping: () => tool === "crop",
        canDrag: () => tool === "select",
        selectTool: () => setTool("select"),
        edit: (update) => {
          if (requireCropResolution()) return;
          cancelDrawing();
          selection.cancel();
          textEditor.commit();
          const next = cloneBeauty(beauty);
          update(next);
          if (JSON.stringify(next) === JSON.stringify(beauty)) return;
          beautyTransaction.begin();
          const visibilityChanged = next.enabled !== beauty.enabled;
          beauty = next;
          markDirty();
          toolbar.syncBeauty?.(beauty.enabled);
          refreshHistory();
          beautyWorkspace?.refresh();
          if (visibilityChanged) cropViewport.fit();
        },
        undo,
        redo,
        hasChanges: beautyTransaction.changed,
        getBeforeDocument: beautyTransaction.before,
        completeRound: finishBeauty,
        revertRound: () => {
          beautyTransaction.revert();
          toolbar.syncBeauty?.(beauty.enabled);
          beautyWorkspace?.sync();
          beautyWorkspace?.refresh();
          cropViewport.fit();
          refreshHistory();
        },
        onLayout: () => cropViewport.fit(),
        onOpen: (open) => toolbar.setBeautyOpen?.(open),
      });
      beautyWorkspace.open();
    } catch (error) {
      if (current === session)
        options.toast(options.translate("beautify.failed", { msg: String(error) }), "error");
    } finally {
      if (current === session) beautyOpening = false;
    }
  };

  const saves = createEditorSaveController({
    getEntry: () => entry,
    getFormat: () => format.value as EditedImageFormat,
    getSession: () => session,
    getRevision: () => revision,
    prepare: () => {
      textEditor.commit();
      finishBeauty();
    },
    exportPng: () => {
      if (!beauty.enabled) return canvasPng(exportCanvas());
      const document = cloneBeauty(beauty),
        time = beautyTime;
      const scale = Number(outputScale.value) / 100,
        whiteBackground = format.value === "jpeg";
      const source = exportCanvas(false);
      return import("../image-beautify/renderer")
        .then(({ composeBeauty }) => composeBeauty(source, document, time, scale, whiteBackground))
        .then(canvasPng)
        .finally(() => {
          source.width = source.height = 0;
        });
    },
    choosePath: (source, outputFormat) => {
      const suffix = outputFormat === "jpeg" ? "jpg" : outputFormat;
      return save({
        defaultPath: `${source.name.replace(/\.[^.]+$/, "")}_edited.${suffix}`,
        filters: [{ name: outputFormat.toUpperCase(), extensions: [suffix] }],
      });
    },
    confirmOverwrite: (source) =>
      confirmDialog.ask({
        title: options.translate("editor.overwriteTitle"),
        message: options.translate("editor.overwriteConfirm", { name: source.name }),
        cancelLabel: options.translate("editor.cancelAction"),
        confirmLabel: options.translate("editor.overwriteTitle"),
      }),
    saveImage: options.saveImage,
    markSaved: (value) => {
      savedRevision = value;
    },
    onSaved: options.onSaved,
    translate: options.translate,
    toast: options.toast,
  });

  const close = async () => {
    if (closing || confirmDialog.isOpen()) return false;
    closing = true;
    try {
      if (saves.isBusy()) await saves.whenIdle();
      selection.cancel();
      cropOverlay.cancel();
      textEditor.commit();
      finishBeauty();
      if (
        (revision !== savedRevision || cropTransaction.changed()) &&
        !(await confirmDialog.ask({
          title: options.translate("editor.discardTitle"),
          message: options.translate("editor.discardConfirm"),
          cancelLabel: options.translate("editor.continueEditing"),
          confirmLabel: options.translate("editor.discardAndExit"),
        }))
      )
        return false;
      session++;
      beautyTransaction.clear();
      beautyWorkspace?.reset();
      loader.cancel();
      paint.discard();
      toolbar.closePanels();
      options.root.classList.add("hidden");
      mosaicCursor.reset();
      viewportInput.reset();
      layers.reset();
      mosaicRenderer.reset();
      canvas.width = canvas.height = sourceCanvas.width = sourceCanvas.height = 0;
      image?.removeAttribute("src");
      image = null;
      entry = null;
      shapes = [];
      drawing.reset();
      crop = null;
      cropTransaction.clear();
      history.clear();
      selection.clear();
      options.onClose();
      return true;
    } finally {
      closing = false;
    }
  };

  canvas.addEventListener(
    "pointerdown",
    (event) => {
      if (image && event.button === 0 && tool !== "select" && tool !== "crop") finishBeauty();
    },
    true,
  );
  canvas.addEventListener("pointerdown", (event) => {
    if (!image || event.button !== 0 || tool === "crop") return;
    if (tool !== "text" && tool !== "select") return;
    const point = displayPoint(event);
    if (tool === "text") {
      event.preventDefault();
      textEditor.click(point);
      return;
    }
    if (tool === "select") {
      selection.down(event);
      return;
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (tool === "select") selection.move(event);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (tool === "select") selection.up(event);
  });
  canvas.addEventListener("pointercancel", selection.cancel);
  canvas.addEventListener("lostpointercapture", selection.cancel);
  canvas.addEventListener("pointerleave", selection.leave);
  surface.addEventListener("pointerdown", (event) => {
    if (event.target === surface && tool === "select" && event.button === 0) selection.clear();
  });
  window.addEventListener("blur", () => selection.cancel());
  window.addEventListener("keydown", (event) => {
    if (options.root.classList.contains("hidden") || confirmDialog.isOpen() || beautyOpening)
      return;
    if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    if (event.key === "Escape" && beautyWorkspace?.isOpen()) {
      event.preventDefault();
      beautyWorkspace.close();
      return;
    }
    if ((event.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]"))
      return;
    if (event.key === "Escape" && selection.isDragging()) {
      event.preventDefault();
      selection.cancel();
      return;
    }
    if (cropTransaction.active && (event.key === "Enter" || event.key === "Escape")) {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (
        event.key === "Enter" &&
        (event.target as HTMLElement)?.closest?.(
          "button, input, textarea, select, [contenteditable]",
        )
      )
        return;
      event.preventDefault();
      if (!event.repeat) finishCrop(event.key === "Enter");
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (event.ctrlKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    } else if (event.key === "Delete" && selection.selected !== null) {
      if ((event.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]"))
        return;
      event.preventDefault();
      deleteSelected();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (!event.repeat) void close();
    }
  });

  const open = async (
    nextEntry: ImageEntry,
    onReady: () => void,
    editContext?: ScreenshotEditContext,
  ) => {
    const nextImage = await loader.load(nextEntry.path);
    if (!nextImage) return false;
    cropOverlay.cancel();
    selection.clear();
    cropTransaction.clear();
    entry = nextEntry;
    mosaicCursor.reset();
    translate();
    image = nextImage;
    shapes = [];
    drawing.reset();
    crop = null;
    cropSnapshot = null;
    textEditor.reset();
    rotation = 0;
    beautyWorkspace?.reset();
    beautyOpening = false;
    beauty = editContext ? cloneBeauty(editContext.document) : emptyBeauty();
    beautyTime = new Date(editContext?.capturedAt ?? Date.now());
    beautyTransaction.clear();
    toolbar.syncBeauty?.(beauty.enabled);
    session++;
    revision = savedRevision = 0;
    if (beauty.enabled) revision = 1;
    history.clear();
    rebuildSource();
    rasterizeAnnotations();
    setTool("select");
    // setTool 已在隐藏状态下画好首帧；这里紧接着显形并让查看器一并切走，不留中间态。
    onReady();
    options.root.classList.remove("hidden");
    toolbar.updateLayout();
    cropViewport.fit();
    toolbar.resetSizes();
    cropOverlay.refreshImage();
    if (editContext) await openBeautify();
    return true;
  };

  return {
    open,
    close,
    requestLeave: close,
    cancelPendingOpen: loader.cancel,
    isOpening: loader.isLoading,
    isOpen: () => !options.root.classList.contains("hidden"),
    refreshTranslations: translate,
  };
}

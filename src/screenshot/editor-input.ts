import { resizeShape, type ResizeOrigin } from "./resize";
import {
  cloneShape,
  normRect,
  shapeBBox,
  translateShape,
  type Pt,
  type Rect,
  type Shape,
  type Tool,
} from "./geometry";

export type DragMode = "none" | "select" | "move" | "resize" | "move-selection" | "pending-win";

interface EditorInputOptions {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  getBounds: () => { totalW: number; totalH: number; minX: number; minY: number };
  getScreens: () => readonly { x: number; y: number; w: number; h: number }[];
  getSelection: () => Rect | null;
  setSelection: (selection: Rect | null) => void;
  getTool: () => Tool | null;
  getStyle: () => { color: string; strokeWidth: number; mosaicWidth: number };
  getShapes: () => Shape[];
  getSelectedIndex: () => number | null;
  setSelectedIndex: (index: number | null) => void;
  getCurrentShape: () => Shape | null;
  setCurrentShape: (shape: Shape | null) => void;
  isTextEditing: () => boolean;
  showTextInput: (point: Pt) => void;
  isScrollActive: () => boolean;
  hitTestShapes: (point: Pt) => number | null;
  hitHandle: (point: Pt) => { index: number; handle: number } | null;
  pickWindowAt: (
    x: number,
    y: number,
  ) => Promise<{ x: number; y: number; width: number; height: number } | null>;
  minShapeSize: number;
  onCheckpoint?: (snapshot: Shape[]) => void;
  render: () => void;
}

/**
 * The pointer state machine for the screenshot editor. It owns transient drag
 * state only; durable editor state remains with the composition root so export,
 * rendering and lifecycle code can share it without a second source of truth.
 */
export function createEditorInputController(options: EditorInputOptions) {
  let dragStart: Pt | null = null;
  let dragCur: Pt | null = null;
  let hoverWin: Rect | null = null;
  let pendingWinSelect: Rect | null = null;
  let dragMode: DragMode = "none";
  let resizeHandle = -1;
  let moveStart: Pt | null = null;
  let moveOrigShape: Shape | null = null;
  let moveHistorySnapshot: Shape[] | null = null;
  let resizeOrig: ResizeOrigin | null = null;
  let resizeHistorySnapshot: Shape[] | null = null;
  let moveSelectionStart: Pt | null = null;
  let moveSelectionOrig: Rect | null = null;
  let lastMousePos: Pt | null = null;
  let overUI = false;
  let lastWinQuery = 0;
  let winQuerySeq = 0;
  let lastQueryPos: Pt | null = null;

  const physPos = (event: MouseEvent): Pt => {
    const rect = options.root.getBoundingClientRect();
    const { totalW, totalH } = options.getBounds();
    return {
      x: (event.clientX - rect.left) * (totalW / rect.width),
      y: (event.clientY - rect.top) * (totalH / rect.height),
    };
  };
  const clampToSelection = (point: Pt): Pt => {
    const selection = options.getSelection();
    if (!selection) return point;
    return {
      x: Math.min(Math.max(point.x, selection.x), selection.x + selection.w),
      y: Math.min(Math.max(point.y, selection.y), selection.y + selection.h),
    };
  };
  const pointInSelection = (point: Pt) => {
    const selection = options.getSelection();
    return (
      !!selection &&
      point.x >= selection.x &&
      point.x <= selection.x + selection.w &&
      point.y >= selection.y &&
      point.y <= selection.y + selection.h
    );
  };
  const checkpoint = (snapshot: Shape[]) => {
    // The caller snapshots on drag start through the array's immutable history hook.
    // This event lets the composition root retain ownership of undo history.
    options.onCheckpoint?.(snapshot);
  };

  function onMouseDown(event: MouseEvent) {
    if (options.isScrollActive() || event.button !== 0 || options.isTextEditing()) return;
    const point = physPos(event);
    const handle = options.hitHandle(point);
    if (handle) {
      dragMode = "resize";
      resizeHandle = handle.handle;
      const shape = options.getShapes()[handle.index];
      resizeOrig = {
        start: { ...shape.start },
        end: { ...shape.end },
        strokeWidth: shape.strokeWidth,
      };
      resizeHistorySnapshot = options.getShapes().map(cloneShape);
      return;
    }
    const hit = options.hitTestShapes(point);
    if (hit !== null) {
      options.setSelectedIndex(hit);
      dragMode = "move";
      moveStart = point;
      moveOrigShape = cloneShape(options.getShapes()[hit]);
      moveHistorySnapshot = options.getShapes().map(cloneShape);
      options.render();
      return;
    }
    const tool = options.getTool();
    if (tool) {
      options.setSelectedIndex(null);
      dragMode = "none";
      if (tool === "text") {
        options.showTextInput(clampToSelection(point));
        return;
      }
      const start = clampToSelection(point);
      const style = options.getStyle();
      options.setCurrentShape({
        tool,
        start: { ...start },
        end: { ...start },
        color: style.color,
        strokeWidth: tool === "mosaic" ? style.mosaicWidth : style.strokeWidth,
        points: tool === "pen" || tool === "mosaic" ? [{ ...start }] : undefined,
      });
      options.render();
      return;
    }
    const selection = options.getSelection();
    if (selection) {
      if (pointInSelection(point)) {
        options.setSelectedIndex(null);
        dragMode = "move-selection";
        moveSelectionStart = { ...point };
        moveSelectionOrig = { ...selection };
      } else if (options.getSelectedIndex() !== null) {
        options.setSelectedIndex(null);
      }
      options.render();
      return;
    }
    if (hoverWin) {
      pendingWinSelect = { ...hoverWin };
      dragMode = "pending-win";
      dragStart = { ...point };
      dragCur = { ...point };
    } else {
      options.setSelectedIndex(null);
      dragMode = "select";
      dragStart = { ...point };
      dragCur = { ...point };
    }
    options.render();
  }

  function onMouseMove(event: MouseEvent) {
    if (options.isScrollActive()) {
      if (options.canvas.style.cursor !== "default") options.canvas.style.cursor = "default";
      return;
    }
    const point = physPos(event);
    lastMousePos = point;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    overUI = !!element && !!(element as HTMLElement).closest?.(".ui-interactive, #text-input");
    if (overUI) {
      if (options.canvas.style.cursor !== "default") options.canvas.style.cursor = "default";
      if (hoverWin && dragMode !== "pending-win") {
        hoverWin = null;
      }
      // UI 浮层会接管鼠标事件，但放大镜仍应使用刚记录的坐标重绘；否则光标进入
      // 工具栏或面板后，放大镜会停在上一帧的位置。
      options.render();
      return;
    }
    if (dragMode === "none" && !options.getSelection() && !options.getTool()) {
      const now = performance.now();
      const moved =
        !lastQueryPos || Math.hypot(point.x - lastQueryPos.x, point.y - lastQueryPos.y) > 2;
      if (now - lastWinQuery > 40 && moved) {
        lastWinQuery = now;
        lastQueryPos = { ...point };
        const seq = ++winQuerySeq;
        const { minX, minY } = options.getBounds();
        void options
          .pickWindowAt(Math.round(point.x + minX), Math.round(point.y + minY))
          .then((windowRect) => {
            if (seq !== winQuerySeq) return;
            if (windowRect)
              hoverWin = {
                x: windowRect.x - minX,
                y: windowRect.y - minY,
                w: windowRect.width,
                h: windowRect.height,
              };
            else {
              const screen = options
                .getScreens()
                .find(
                  (s) =>
                    point.x >= s.x && point.x < s.x + s.w && point.y >= s.y && point.y < s.y + s.h,
                );
              hoverWin = screen ? { x: screen.x, y: screen.y, w: screen.w, h: screen.h } : null;
            }
            options.render();
          });
      }
    } else if (hoverWin && dragMode !== "pending-win") hoverWin = null;

    if (dragMode === "pending-win") {
      dragCur = point;
      if (dragStart && Math.hypot(point.x - dragStart.x, point.y - dragStart.y) > 3) {
        pendingWinSelect = null;
        hoverWin = null;
        dragMode = "select";
      }
      options.render();
      return;
    }
    if (dragMode === "select") {
      dragCur = point;
      options.render();
      return;
    }
    const selectedIndex = options.getSelectedIndex();
    if (dragMode === "move" && moveStart && moveOrigShape && selectedIndex !== null) {
      const selection = options.getSelection();
      const shape = options.getShapes()[selectedIndex];
      const dx = point.x - moveStart.x,
        dy = point.y - moveStart.y;
      let ddx = dx,
        ddy = dy;
      if (selection) {
        const minX = Math.min(moveOrigShape.start.x, moveOrigShape.end.x),
          maxX = Math.max(moveOrigShape.start.x, moveOrigShape.end.x);
        const minY = Math.min(moveOrigShape.start.y, moveOrigShape.end.y),
          maxY = Math.max(moveOrigShape.start.y, moveOrigShape.end.y);
        if (minX + dx < selection.x) ddx = selection.x - minX;
        if (maxX + dx > selection.x + selection.w) ddx = selection.x + selection.w - maxX;
        if (minY + dy < selection.y) ddy = selection.y - minY;
        if (maxY + dy > selection.y + selection.h) ddy = selection.y + selection.h - maxY;
      }
      shape.start = { x: moveOrigShape.start.x + ddx, y: moveOrigShape.start.y + ddy };
      shape.end = { x: moveOrigShape.end.x + ddx, y: moveOrigShape.end.y + ddy };
      if (shape.points && moveOrigShape.points)
        shape.points = moveOrigShape.points.map((p) => ({ x: p.x + ddx, y: p.y + ddy }));
      options.render();
      return;
    }
    if (dragMode === "resize" && resizeOrig && selectedIndex !== null) {
      const resized = resizeShape(
        options.getShapes()[selectedIndex],
        resizeOrig,
        resizeHandle,
        clampToSelection(point),
        options.minShapeSize,
      );
      if (resized) options.getShapes()[selectedIndex] = resized;
      options.render();
      return;
    }
    if (dragMode === "move-selection" && moveSelectionStart && moveSelectionOrig) {
      const { totalW, totalH } = options.getBounds();
      const x = Math.min(
        Math.max(moveSelectionOrig.x + point.x - moveSelectionStart.x, 0),
        Math.max(0, totalW - moveSelectionOrig.w),
      );
      const y = Math.min(
        Math.max(moveSelectionOrig.y + point.y - moveSelectionStart.y, 0),
        Math.max(0, totalH - moveSelectionOrig.h),
      );
      const dx = x - moveSelectionOrig.x,
        dy = y - moveSelectionOrig.y;
      options.setSelection({ x, y, w: moveSelectionOrig.w, h: moveSelectionOrig.h });
      for (const shape of options.getShapes()) translateShape(shape, dx, dy);
      options.render();
      return;
    }
    const currentShape = options.getCurrentShape();
    if (currentShape) {
      const end = clampToSelection(point);
      currentShape.end = end;
      if ((currentShape.tool === "pen" || currentShape.tool === "mosaic") && currentShape.points) {
        const last = currentShape.points[currentShape.points.length - 1];
        if (!last || Math.hypot(end.x - last.x, end.y - last.y) > 2)
          currentShape.points.push({ ...end });
      }
      options.render();
      return;
    }
    const hit = options.hitTestShapes(point);
    const cursor =
      hit !== null
        ? "move"
        : options.getTool()
          ? "crosshair"
          : !options.getSelection()
            ? "crosshair"
            : pointInSelection(point)
              ? "move"
              : "not-allowed";
    if (options.canvas.style.cursor !== cursor) options.canvas.style.cursor = cursor;
    options.render();
  }

  function onMouseUp(event: MouseEvent) {
    if (event.button !== 0) return;
    if (dragMode === "pending-win") {
      if (pendingWinSelect) options.setSelection({ ...pendingWinSelect });
      pendingWinSelect = null;
      hoverWin = null;
      dragMode = "none";
      dragStart = dragCur = null;
      options.render();
      return;
    }
    if (dragMode === "select") {
      const rect = dragStart && dragCur ? normRect(dragStart, dragCur) : null;
      options.setSelection(
        rect && rect.w >= options.minShapeSize && rect.h >= options.minShapeSize ? rect : null,
      );
      dragStart = dragCur = null;
      dragMode = "none";
      options.render();
      return;
    }
    const selectedIndex = options.getSelectedIndex();
    if (dragMode === "move") {
      const shape = selectedIndex === null ? null : options.getShapes()[selectedIndex];
      if (
        shape &&
        moveOrigShape &&
        (shape.start.x !== moveOrigShape.start.x || shape.start.y !== moveOrigShape.start.y)
      )
        checkpoint(moveHistorySnapshot ?? []);
      dragMode = "none";
      moveStart = null;
      moveOrigShape = null;
      moveHistorySnapshot = null;
      options.render();
      return;
    }
    if (dragMode === "resize") {
      const shape = selectedIndex === null ? null : options.getShapes()[selectedIndex];
      if (
        shape &&
        resizeOrig &&
        resizeHistorySnapshot &&
        (shape.start.x !== resizeOrig.start.x ||
          shape.start.y !== resizeOrig.start.y ||
          shape.end.x !== resizeOrig.end.x ||
          shape.end.y !== resizeOrig.end.y ||
          shape.strokeWidth !== resizeOrig.strokeWidth)
      )
        checkpoint(resizeHistorySnapshot);
      dragMode = "none";
      resizeHandle = -1;
      resizeOrig = null;
      resizeHistorySnapshot = null;
      options.render();
      return;
    }
    if (dragMode === "move-selection") {
      dragMode = "none";
      moveSelectionStart = null;
      moveSelectionOrig = null;
      options.render();
      return;
    }
    const currentShape = options.getCurrentShape();
    if (currentShape) {
      options.setCurrentShape(null);
      const box = shapeBBox(currentShape);
      if (box.w >= options.minShapeSize && box.h >= options.minShapeSize) {
        checkpoint(options.getShapes().map(cloneShape));
        options.getShapes().push(currentShape);
      }
      options.render();
    }
  }

  return {
    onMouseDown,
    onMouseMove,
    onMouseUp,
    getFrameState: () => ({ dragMode, dragStart, dragCur, hoverWin, lastMousePos, overUI }),
    reset: () => {
      dragStart = dragCur = null;
      hoverWin = null;
      pendingWinSelect = null;
      dragMode = "none";
      resizeHandle = -1;
      moveStart = null;
      moveOrigShape = null;
      moveHistorySnapshot = null;
      resizeOrig = null;
      resizeHistorySnapshot = null;
      moveSelectionStart = null;
      moveSelectionOrig = null;
      lastMousePos = null;
      overUI = false;
    },
  };
}

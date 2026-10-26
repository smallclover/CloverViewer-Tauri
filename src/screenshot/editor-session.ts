import { SnapshotHistory, shapeHistoryBytes } from "../image-editor/history";
import type { BeautifyDocument } from "../api";
import { cloneBeauty, emptyBeauty } from "../image-beautify/model";
import { cloneShape, translateShape, type Rect, type Shape, type Tool } from "./geometry";

export interface EditorSessionOptions {
  color: string;
  strokeWidth: number;
}

/** 输入、渲染、导出与生命周期代码共用的持久标注状态。 */
export function createEditorSession(options: EditorSessionOptions) {
  let selection: Rect | null = null;
  let tool: Tool | null = null;
  let color = options.color;
  let strokeWidth = options.strokeWidth;
  let shapes: Shape[] = [];
  let currentShape: Shape | null = null;
  let selectedIndex: number | null = null;
  let beauty = emptyBeauty();
  interface Snapshot {
    shapes: Shape[];
    beauty: BeautifyDocument;
  }
  const history = new SnapshotHistory<Snapshot>(
    (value) => ({
      shapes: value.shapes.map(cloneShape),
      beauty: cloneBeauty(value.beauty),
    }),
    (value) => shapeHistoryBytes(value.shapes) + JSON.stringify(value.beauty).length * 2,
  );

  // 历史保存选区局部坐标：移动整个选区后，撤销/重做仍落在当前选区，包含已有 redo。
  const relative = (snapshot: Shape[]) =>
    snapshot.map((shape) => {
      const copy = cloneShape(shape);
      translateShape(copy, -(selection?.x ?? 0), -(selection?.y ?? 0));
      return copy;
    });
  const restore = (snapshot: Snapshot) => {
    for (const shape of snapshot.shapes)
      translateShape(shape, selection?.x ?? 0, selection?.y ?? 0);
    shapes = snapshot.shapes;
    beauty = snapshot.beauty;
    selectedIndex = null;
  };
  const checkpoint = (snapshot = shapes) =>
    history.checkpoint({ shapes: relative(snapshot), beauty });
  const undo = () => {
    const previous = history.undo({ shapes: relative(shapes), beauty });
    if (!previous) return false;
    restore(previous);
    return true;
  };
  const redo = () => {
    const next = history.redo({ shapes: relative(shapes), beauty });
    if (!next) return false;
    restore(next);
    return true;
  };
  const deleteSelected = () => {
    if (selectedIndex === null) return false;
    checkpoint();
    shapes.splice(selectedIndex, 1);
    selectedIndex = null;
    return true;
  };
  const reset = () => {
    selection = null;
    tool = null;
    shapes = [];
    currentShape = null;
    selectedIndex = null;
    beauty = emptyBeauty();
    history.clear();
  };

  return {
    get beauty() {
      return beauty;
    },
    set beauty(value: BeautifyDocument) {
      beauty = value;
    },
    get selection() {
      return selection;
    },
    set selection(value: Rect | null) {
      selection = value;
    },
    get tool() {
      return tool;
    },
    set tool(value: Tool | null) {
      tool = value;
    },
    get color() {
      return color;
    },
    set color(value: string) {
      color = value;
    },
    get strokeWidth() {
      return strokeWidth;
    },
    set strokeWidth(value: number) {
      strokeWidth = value;
    },
    get shapes() {
      return shapes;
    },
    set shapes(value: Shape[]) {
      shapes = value;
    },
    get currentShape() {
      return currentShape;
    },
    set currentShape(value: Shape | null) {
      currentShape = value;
    },
    get selectedIndex() {
      return selectedIndex;
    },
    set selectedIndex(value: number | null) {
      selectedIndex = value;
    },
    checkpoint,
    undo,
    redo,
    deleteSelected,
    reset,
  };
}

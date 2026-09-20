import { ShapeHistory } from "./history";
import type { Rect, Shape, Tool } from "./geometry";

export interface EditorSessionOptions {
  color: string;
  strokeWidth: number;
}

/** Durable annotation state shared by input, rendering, export, and lifecycle code. */
export function createEditorSession(options: EditorSessionOptions) {
  let selection: Rect | null = null;
  let tool: Tool | null = null;
  let color = options.color;
  let strokeWidth = options.strokeWidth;
  let shapes: Shape[] = [];
  let currentShape: Shape | null = null;
  let selectedIndex: number | null = null;
  const history = new ShapeHistory();

  const checkpoint = (snapshot = shapes) => history.checkpoint(snapshot);
  const undo = () => {
    const previous = history.undo(shapes);
    if (!previous) return false;
    shapes = previous;
    selectedIndex = null;
    return true;
  };
  const redo = () => {
    const next = history.redo(shapes);
    if (!next) return false;
    shapes = next;
    selectedIndex = null;
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
    history.clear();
  };

  return {
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

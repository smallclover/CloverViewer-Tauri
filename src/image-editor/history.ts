import { cloneShape, type Shape } from "./geometry";

const HISTORY_LIMIT = 50;
const HISTORY_BYTES = 32 * 1024 * 1024;
interface Entry<T> {
  value: T;
  bytes: number;
}
export const shapeHistoryBytes = (shapes: readonly Shape[]) =>
  shapes.reduce(
    (bytes, shape) =>
      bytes + 256 + (shape.text?.length ?? 0) * 2 + (shape.points?.length ?? 0) * 48,
    0,
  );

/** 每步独立快照；总内存按保守估值淘汰旧步骤，至少保留最近一步。 */
export class SnapshotHistory<T> {
  private undoStack: Entry<T>[] = [];
  private redoStack: Entry<T>[] = [];
  constructor(
    private readonly clone: (snapshot: T) => T,
    private readonly measure: (snapshot: T) => number = () => 0,
    private readonly maxBytes = HISTORY_BYTES,
  ) {}
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  private push(stack: Entry<T>[], snapshot: T) {
    stack.push({ value: this.clone(snapshot), bytes: this.measure(snapshot) });
    if (stack.length > HISTORY_LIMIT) stack.shift();
    let bytes = [...this.undoStack, ...this.redoStack].reduce((sum, entry) => sum + entry.bytes, 0);
    while (bytes > this.maxBytes && this.undoStack.length + this.redoStack.length > 1) {
      const entry = this.undoStack.length ? this.undoStack.shift() : this.redoStack.shift();
      bytes -= entry?.bytes ?? 0;
    }
  }
  checkpoint(snapshot: T) {
    this.redoStack = [];
    this.push(this.undoStack, snapshot);
  }
  undo(current: T): T | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.push(this.redoStack, current);
    return previous.value;
  }
  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.push(this.undoStack, current);
    return next.value;
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

export class ShapeHistory extends SnapshotHistory<Shape[]> {
  constructor(maxBytes = HISTORY_BYTES) {
    super((shapes) => shapes.map(cloneShape), shapeHistoryBytes, maxBytes);
  }
}

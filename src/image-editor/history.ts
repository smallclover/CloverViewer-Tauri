import { cloneShape, type Shape } from "./geometry";

const HISTORY_LIMIT = 50;

/** Immutable snapshots for an editor state that includes more than annotations. */
export class SnapshotHistory<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];

  constructor(private readonly clone: (snapshot: T) => T) {}

  checkpoint(snapshot: T) {
    this.undoStack.push(this.clone(snapshot));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: T): T | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(this.clone(current));
    return this.clone(previous);
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(this.clone(current));
    return this.clone(next);
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** Immutable annotation snapshots; both editors use the same undo semantics. */
export class ShapeHistory {
  private undoStack: Shape[][] = [];
  private redoStack: Shape[][] = [];

  checkpoint(shapes: Shape[]) {
    this.undoStack.push(shapes.map(cloneShape));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: Shape[]): Shape[] | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(current.map(cloneShape));
    return previous.map(cloneShape);
  }

  redo(current: Shape[]): Shape[] | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(current.map(cloneShape));
    return next.map(cloneShape);
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

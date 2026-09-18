import { cloneShape, type Shape } from "./geometry";

const HISTORY_LIMIT = 50;

function cloneShapes(shapes: Shape[]): Shape[] {
  return shapes.map(cloneShape);
}

/** Stores immutable annotation snapshots for undo and redo. */
export class ShapeHistory {
  private undoStack: Shape[][] = [];
  private redoStack: Shape[][] = [];

  checkpoint(shapes: Shape[]) {
    this.undoStack.push(cloneShapes(shapes));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: Shape[]): Shape[] | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(cloneShapes(current));
    return cloneShapes(previous);
  }

  redo(current: Shape[]): Shape[] | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(cloneShapes(current));
    return cloneShapes(next);
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

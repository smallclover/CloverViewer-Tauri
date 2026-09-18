export const THUMB_WIDTHS = [136, 172, 220] as const;

const GAP = 16;
const HORIZONTAL_PADDING = 48;
const BUFFER_ROWS = 2;

export interface GridLayout {
  columns: number;
  cellWidth: number;
  thumbHeight: number;
  cellHeight: number;
  totalHeight: number;
}

export function createGridLayout(
  viewportWidth: number,
  itemCount: number,
  cellWidth: number,
): GridLayout {
  const thumbHeight = Math.round(cellWidth * 0.744);
  const cellHeight = thumbHeight + 52;
  const columns = Math.max(
    1,
    Math.floor((viewportWidth - HORIZONTAL_PADDING + GAP) / (cellWidth + GAP)),
  );
  const rows = Math.ceil(itemCount / columns);

  return {
    columns,
    cellWidth,
    thumbHeight,
    cellHeight,
    totalHeight: rows * cellHeight + Math.max(0, rows - 1) * GAP,
  };
}

export function visibleItemRange(
  scrollTop: number,
  viewportHeight: number,
  itemCount: number,
  layout: GridLayout,
): [number, number] {
  const rowHeight = layout.cellHeight + GAP;
  const firstRow = Math.floor(scrollTop / rowHeight);
  const lastRow = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  return [
    Math.min(itemCount, Math.max(0, (firstRow - BUFFER_ROWS) * layout.columns)),
    Math.min(itemCount, (lastRow + BUFFER_ROWS) * layout.columns),
  ];
}

export function thumbnailPixelSize(cellWidth: number): number {
  return Math.min(384, Math.max(160, Math.round(cellWidth * (window.devicePixelRatio || 1))));
}

export const GRID_GAP = GAP;

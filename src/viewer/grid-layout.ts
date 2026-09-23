/** Number of columns used by the small, medium, and large gallery sizes. */
export const THUMB_COLUMNS = [6, 4, 3] as const;

const GAP = 16;
export const GRID_HORIZONTAL_PADDING = 96;
const MIN_CELL_WIDTH = 136;
const BUFFER_ROWS = 2;
const SECTION_HEADING_HEIGHT = 32;
const SECTION_GAP = 16;

export interface GridLayout {
  columns: number;
  cellWidth: number;
  thumbHeight: number;
  cellHeight: number;
  totalHeight: number;
}

export interface GridSection {
  startIndex: number;
  itemCount: number;
  top: number;
  itemsTop: number;
  itemsBottom: number;
}

export function createGridLayout(
  viewportWidth: number,
  itemCount: number,
  preferredColumns: number,
): GridLayout {
  const availableWidth = Math.max(1, viewportWidth - GRID_HORIZONTAL_PADDING);
  const maxColumns = Math.max(1, Math.floor((availableWidth + GAP) / (MIN_CELL_WIDTH + GAP)));
  const columns = Math.min(preferredColumns, maxColumns);
  const cellWidth = Math.floor((availableWidth - (columns - 1) * GAP) / columns);
  const thumbHeight = Math.round(cellWidth * 0.625);
  const cellHeight = thumbHeight;
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

/** Lays out consecutive date groups while retaining virtualizable image rows. */
export function createGridSections(
  groupKeys: readonly string[],
  layout: GridLayout,
): { sections: GridSection[]; totalHeight: number } {
  const sections: GridSection[] = [];
  let startIndex = 0;
  let top = 0;

  while (startIndex < groupKeys.length) {
    let endIndex = startIndex + 1;
    while (endIndex < groupKeys.length && groupKeys[endIndex] === groupKeys[startIndex])
      endIndex += 1;
    const itemCount = endIndex - startIndex;
    const rows = Math.ceil(itemCount / layout.columns);
    const itemsTop = top + SECTION_HEADING_HEIGHT;
    const itemsBottom = itemsTop + rows * layout.cellHeight + Math.max(0, rows - 1) * GAP;
    sections.push({ startIndex, itemCount, top, itemsTop, itemsBottom });
    top = itemsBottom + SECTION_GAP;
    startIndex = endIndex;
  }

  return { sections, totalHeight: Math.max(0, top - SECTION_GAP) };
}

export function thumbnailPixelSize(cellWidth: number): number {
  return Math.min(384, Math.max(160, Math.round(cellWidth * (window.devicePixelRatio || 1))));
}

export const GRID_GAP = GAP;

/** 小、中、大三档缩略图尺寸各自使用的列数。 */
export const THUMB_COLUMNS = [6, 4, 3] as const;

const GAP = 16;
export const GRID_HORIZONTAL_PADDING = 96;
const MIN_CELL_WIDTH = 136;
const BUFFER_ROWS = 2;
const SECTION_HEADING_HEIGHT = 48;
const SECTION_GAP = 28;

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

/** 与分组几何共用的虚拟滚动范围；每个分组独立起行，保留上下两行缓冲。 */
export function visibleSectionItems(
  scrollTop: number,
  viewportHeight: number,
  sections: readonly GridSection[],
  layout: GridLayout,
): Set<number> {
  const needed = new Set<number>();
  const rowHeight = layout.cellHeight + GAP;
  const visibleTop = Math.max(0, scrollTop - rowHeight * BUFFER_ROWS);
  const visibleBottom = scrollTop + viewportHeight + rowHeight * BUFFER_ROWS;
  for (const section of sections) {
    if (section.itemsBottom <= visibleTop || section.itemsTop >= visibleBottom) continue;
    const firstRow = Math.max(0, Math.floor((visibleTop - section.itemsTop) / rowHeight));
    const lastRow = Math.ceil((visibleBottom - section.itemsTop) / rowHeight);
    const from = section.startIndex + firstRow * layout.columns;
    const to = Math.min(
      section.startIndex + section.itemCount,
      section.startIndex + lastRow * layout.columns,
    );
    for (let index = from; index < to; index += 1) needed.add(index);
  }
  return needed;
}

/** 按连续的日期分组排版，同时保留可虚拟化的图片行。 */
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

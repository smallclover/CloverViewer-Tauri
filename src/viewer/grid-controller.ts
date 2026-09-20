import {
  createGridLayout,
  GRID_GAP,
  thumbnailPixelSize,
  THUMB_WIDTHS,
  visibleItemRange,
} from "./grid-layout";
import type { createImageSourceResolver } from "./image-source";
import type { createViewerSession } from "./viewer-session";

interface GridControllerOptions {
  gridView: HTMLElement;
  grid: HTMLElement;
  spacer: HTMLElement;
  sortButton: HTMLButtonElement;
  sizeButton: HTMLButtonElement;
  session: ReturnType<typeof createViewerSession>;
  imageSource: ReturnType<typeof createImageSourceResolver>;
  getThumbnail: (path: string, size: number) => Promise<string>;
  formatDimensions: (width: number, height: number) => string;
  translate: (key: string) => string;
  onSelect: (index: number) => void;
}

/** Owns virtualized thumbnail rendering and its local sort/size presentation state. */
export function createGridController(options: GridControllerOptions) {
  let thumbSizeIndex = 1;
  let cellWidth = THUMB_WIDTHS[thumbSizeIndex];
  let thumbHeight = Math.round(cellWidth * 0.744);
  let cellHeight = thumbHeight + 52;
  let newestFirst = true;
  let columns = 4;
  const renderedCells = new Map<number, HTMLElement>();
  let scrollFrame = 0;

  const thumbnailSize = () => thumbnailPixelSize(cellWidth);

  const renderGrid = () => {
    const layout = createGridLayout(
      options.gridView.clientWidth,
      options.session.images.length,
      cellWidth,
    );
    columns = layout.columns;
    thumbHeight = layout.thumbHeight;
    cellHeight = layout.cellHeight;
    options.spacer.style.height = `${layout.totalHeight}px`;
    for (const element of renderedCells.values()) element.remove();
    renderedCells.clear();
    renderVisible();
  };

  const renderVisible = () => {
    const layout = createGridLayout(
      options.gridView.clientWidth,
      options.session.images.length,
      cellWidth,
    );
    const [from, to] = visibleItemRange(
      options.gridView.scrollTop,
      options.gridView.clientHeight,
      options.session.images.length,
      layout,
    );
    const needed = new Set<number>();
    for (let index = from; index < to; index++) needed.add(index);
    for (const [index, element] of renderedCells) {
      if (!needed.has(index)) {
        element.remove();
        renderedCells.delete(index);
      }
    }
    for (let index = from; index < to; index++) {
      if (!renderedCells.has(index)) {
        const element = createCell(index);
        renderedCells.set(index, element);
        options.grid.appendChild(element);
      }
    }
  };

  const createCell = (index: number) => {
    const entry = options.session.images[index];
    const cell = document.createElement("div");
    cell.className = `cell${index === options.session.activeIndex ? " active" : ""}`;
    cell.dataset.index = String(index);
    const column = index % columns;
    const row = Math.floor(index / columns);
    cell.style.left = `${column * (cellWidth + GRID_GAP)}px`;
    cell.style.top = `${row * (cellHeight + GRID_GAP)}px`;
    cell.style.width = `${cellWidth}px`;

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.style.height = `${thumbHeight}px`;
    const image = document.createElement("img");
    image.alt = entry.name;
    image.draggable = false;
    thumb.appendChild(image);
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = entry.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = options.formatDimensions(entry.width, entry.height);
    cell.append(thumb, label, meta);
    cell.addEventListener("click", () => options.onSelect(index));

    void options
      .getThumbnail(entry.path, thumbnailSize())
      .then((dataUrl) => {
        image.src = dataUrl;
      })
      .catch(() => {
        void options.imageSource.for(entry).then((source) => {
          image.src = source;
        });
      });
    return cell;
  };

  const refreshMenu = () => {
    options.sortButton.textContent = newestFirst
      ? options.translate("view.sortNewest")
      : options.translate("view.sortOldest");
    options.sizeButton.textContent = options.translate(
      ["view.thumbSmall", "view.thumbMedium", "view.thumbLarge"][thumbSizeIndex],
    );
  };

  const toggleSort = () => {
    newestFirst = !newestFirst;
    const activePath =
      options.session.activeIndex >= 0
        ? options.session.images[options.session.activeIndex]?.path
        : undefined;
    options.session.images.sort((a, b) => {
      const delta = new Date(a.modified).getTime() - new Date(b.modified).getTime();
      return newestFirst ? -delta : delta;
    });
    options.session.activeIndex = activePath
      ? options.session.images.findIndex((entry) => entry.path === activePath)
      : -1;
    refreshMenu();
    renderGrid();
  };

  const cycleSize = () => {
    thumbSizeIndex = (thumbSizeIndex + 1) % THUMB_WIDTHS.length;
    cellWidth = THUMB_WIDTHS[thumbSizeIndex];
    thumbHeight = Math.round(cellWidth * 0.744);
    cellHeight = thumbHeight + 52;
    refreshMenu();
    renderGrid();
  };

  const updateActive = () => {
    for (const [index, element] of renderedCells) {
      element.classList.toggle("active", index === options.session.activeIndex);
    }
  };

  options.gridView.addEventListener("scroll", () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      renderVisible();
    });
  });

  return { renderGrid, refreshMenu, toggleSort, cycleSize, updateActive };
}

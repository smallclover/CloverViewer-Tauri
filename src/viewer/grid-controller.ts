import {
  createGridLayout,
  createGridSections,
  GRID_GAP,
  type GridLayout,
  type GridSection,
  thumbnailPixelSize,
  THUMB_COLUMNS,
} from "./grid-layout";
import type { createImageSourceResolver } from "./image-source";
import type { createViewerSession } from "./viewer-session";

interface GridControllerOptions {
  gridView: HTMLElement;
  grid: HTMLElement;
  spacer: HTMLElement;
  sortButton: HTMLButtonElement;
  sortLabel: HTMLElement;
  sortMenu: HTMLElement;
  sizeButton: HTMLButtonElement;
  sizeLabel: HTMLElement;
  sizeMenu: HTMLElement;
  sizeSlider: HTMLInputElement;
  session: ReturnType<typeof createViewerSession>;
  imageSource: ReturnType<typeof createImageSourceResolver>;
  getThumbnail: (path: string, size: number) => Promise<string>;
  translate: (key: string) => string;
  onSelect: (index: number) => void;
}

/** Owns virtualized thumbnail rendering and its local sort/size presentation state. */
export function createGridController(options: GridControllerOptions) {
  let thumbSizeIndex = 1;
  let cellWidth = 0;
  let thumbHeight = 0;
  let cellHeight = 0;
  let newestFirst = true;
  let columns = 4;
  let layout: GridLayout = createGridLayout(0, 0, THUMB_COLUMNS[thumbSizeIndex]);
  let sections: GridSection[] = [];
  let sectionForImage: GridSection[] = [];
  const renderedCells = new Map<number, HTMLElement>();
  const sectionHeadings: HTMLElement[] = [];
  let scrollFrame = 0;

  const thumbnailSize = () => thumbnailPixelSize(cellWidth);

  const dateGroupKey = (modified: string) => {
    const date = new Date(modified);
    return Number.isNaN(date.getTime())
      ? "unknown"
      : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  };

  const formatPeriod = (modified: string) => {
    const date = new Date(modified);
    return Number.isNaN(date.getTime())
      ? options.translate("view.unknownDate")
      : new Intl.DateTimeFormat(document.documentElement.lang || "zh-CN", {
          year: "numeric",
          month: "long",
        }).format(date);
  };

  const renderSectionHeadings = () => {
    for (const heading of sectionHeadings) heading.remove();
    sectionHeadings.length = 0;
    for (const section of sections) {
      const heading = document.createElement("h2");
      heading.className = "grid-section-heading";
      heading.textContent = formatPeriod(options.session.images[section.startIndex].modified);
      heading.style.top = `${section.top}px`;
      options.grid.appendChild(heading);
      sectionHeadings.push(heading);
    }
  };

  const renderGrid = () => {
    layout = createGridLayout(
      options.gridView.clientWidth,
      options.session.images.length,
      THUMB_COLUMNS[thumbSizeIndex],
    );
    columns = layout.columns;
    cellWidth = layout.cellWidth;
    thumbHeight = layout.thumbHeight;
    cellHeight = layout.cellHeight;
    const groupedLayout = createGridSections(
      options.session.images.map((entry) => dateGroupKey(entry.modified)),
      layout,
    );
    sections = groupedLayout.sections;
    sectionForImage = [];
    for (const section of sections) {
      for (
        let index = section.startIndex;
        index < section.startIndex + section.itemCount;
        index += 1
      ) {
        sectionForImage[index] = section;
      }
    }
    renderSectionHeadings();
    options.spacer.style.height = `${groupedLayout.totalHeight}px`;
    for (const element of renderedCells.values()) element.remove();
    renderedCells.clear();
    renderVisible();
  };

  const renderVisible = () => {
    const needed = new Set<number>();
    const rowHeight = cellHeight + GRID_GAP;
    const visibleTop = Math.max(0, options.gridView.scrollTop - rowHeight * 2);
    const visibleBottom =
      options.gridView.scrollTop + options.gridView.clientHeight + rowHeight * 2;
    for (const section of sections) {
      if (section.itemsBottom <= visibleTop || section.itemsTop >= visibleBottom) continue;
      const firstRow = Math.max(0, Math.floor((visibleTop - section.itemsTop) / rowHeight));
      const lastRow = Math.ceil((visibleBottom - section.itemsTop) / rowHeight);
      const from = section.startIndex + firstRow * columns;
      const to = Math.min(
        section.startIndex + section.itemCount,
        section.startIndex + lastRow * columns,
      );
      for (let index = from; index < to; index += 1) needed.add(index);
    }
    for (const [index, element] of renderedCells) {
      if (!needed.has(index)) {
        element.remove();
        renderedCells.delete(index);
      }
    }
    for (const index of needed) {
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
    cell.title = entry.name;
    const section = sectionForImage[index];
    const localIndex = index - section.startIndex;
    const column = localIndex % columns;
    const row = Math.floor(localIndex / columns);
    cell.style.left = `${column * (cellWidth + GRID_GAP)}px`;
    cell.style.top = `${section.itemsTop + row * (cellHeight + GRID_GAP)}px`;
    cell.style.width = `${cellWidth}px`;

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.style.height = `${thumbHeight}px`;
    const image = document.createElement("img");
    image.alt = entry.name;
    image.draggable = false;
    thumb.appendChild(image);
    cell.append(thumb);
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
    options.sortLabel.textContent = newestFirst
      ? options.translate("view.sortNewest")
      : options.translate("view.sortOldest");
    options.sizeLabel.textContent = options.translate(
      ["view.thumbSmall", "view.thumbMedium", "view.thumbLarge"][thumbSizeIndex],
    );
    options.sizeSlider.value = String(thumbSizeIndex);
    options.sizeSlider.style.setProperty("--progress", `${thumbSizeIndex * 50}%`);
    options.sizeSlider.ariaLabel = options.translate("view.thumbSizeTitle");
    options.sizeSlider.title = options.translate("view.thumbSizeTitle");
    options.sortMenu.querySelectorAll<HTMLButtonElement>("[data-sort-order]").forEach((button) => {
      const selected = button.dataset.sortOrder === (newestFirst ? "newest" : "oldest");
      button.classList.toggle("selected", selected);
      button.ariaChecked = String(selected);
    });
    options.sizeMenu.querySelectorAll<HTMLButtonElement>("[data-size-index]").forEach((button) => {
      const selected = Number(button.dataset.sizeIndex) === thumbSizeIndex;
      button.classList.toggle("selected", selected);
      button.ariaChecked = String(selected);
    });
  };

  const setNewestFirst = (nextNewestFirst: boolean) => {
    if (newestFirst === nextNewestFirst) return;
    newestFirst = nextNewestFirst;
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

  const toggleSort = () => setNewestFirst(!newestFirst);

  const setThumbSize = (nextIndex: number) => {
    thumbSizeIndex = Math.max(0, Math.min(THUMB_COLUMNS.length - 1, nextIndex));
    cellWidth = 0;
    thumbHeight = 0;
    cellHeight = 0;
    refreshMenu();
    renderGrid();
  };

  const cycleSize = () => setThumbSize((thumbSizeIndex + 1) % THUMB_COLUMNS.length);

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
  options.sizeSlider.addEventListener("input", () => {
    setThumbSize(Number(options.sizeSlider.value));
  });

  return {
    renderGrid,
    refreshMenu,
    setNewestFirst,
    setThumbSize,
    toggleSort,
    cycleSize,
    updateActive,
  };
}

import type { ImageEntry } from "../api";

export type ViewerMode = "grid" | "single" | "edit";

/** Shared durable state for directory, image selection, and the active viewer mode. */
export function createViewerSession() {
  let currentDir = "";
  let images: ImageEntry[] = [];
  let activeIndex = -1;
  let viewMode: ViewerMode = "grid";
  let propsVisible = false;

  return {
    get currentDir() {
      return currentDir;
    },
    set currentDir(value: string) {
      currentDir = value;
    },
    get images() {
      return images;
    },
    set images(value: ImageEntry[]) {
      images = value;
    },
    get activeIndex() {
      return activeIndex;
    },
    set activeIndex(value: number) {
      activeIndex = value;
    },
    get viewMode() {
      return viewMode;
    },
    set viewMode(value: ViewerMode) {
      viewMode = value;
    },
    get propsVisible() {
      return propsVisible;
    },
    set propsVisible(value: boolean) {
      propsVisible = value;
    },
    setDirectory(dir: string, entries: ImageEntry[]) {
      currentDir = dir;
      images = entries;
      activeIndex = -1;
    },
  };
}

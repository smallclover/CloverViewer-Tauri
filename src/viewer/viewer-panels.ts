import type { ImageEntry } from "../api";
import type { createViewerSession } from "./viewer-session";

type Session = Pick<
  ReturnType<typeof createViewerSession>,
  "images" | "activeIndex" | "viewMode" | "propsVisible"
>;

/** 属性、分享和 OCR 侧栏共用互斥与导航边界；各控制器继续拥有自己的异步任务。 */
export function createViewerPanels(options: {
  session: Session;
  properties: { panel: HTMLElement; render: (entry: ImageEntry) => void };
  share: { panel: HTMLElement; open: (entry: ImageEntry) => void; close: () => void };
  ocr: {
    open: (entry: ImageEntry) => unknown;
    close: () => void;
    isOpen: () => boolean;
    hasResult: (path: string) => boolean;
  };
  showImage: (index: number) => void;
  onLayout: () => void;
}) {
  const { session, properties, share, ocr } = options;
  let depth = 0;
  let layoutPending = false;
  const changed = () => {
    if (session.viewMode === "single") layoutPending = true;
  };
  const change = (action: () => void) => {
    depth++;
    try {
      action();
    } finally {
      // showImage 可同步回到 applyProperties/closeTransient；只在最终侧栏落定后重排。
      if (--depth === 0 && layoutPending) {
        layoutPending = false;
        if (session.viewMode === "single") options.onLayout();
      }
    }
  };
  const refreshProperties = () => {
    const entry = session.images[session.activeIndex];
    if (session.viewMode === "single" && session.propsVisible && entry) properties.render(entry);
  };
  const applyProperties = () => {
    properties.panel.classList.toggle("collapsed", !session.propsVisible);
    refreshProperties();
    changed();
  };
  const closeShare = () => {
    share.close();
    share.panel.classList.add("collapsed");
    changed();
  };
  const closeOcr = () => {
    if (!ocr.isOpen()) return;
    ocr.close();
    changed();
  };
  const closeTransient = () => {
    closeShare();
    closeOcr();
  };
  const open = (kind: "properties" | "share" | "ocr", entry: ImageEntry) => {
    const index = session.images.findIndex((image) => image.path === entry.path);
    if (index < 0 || (kind === "ocr" && !ocr.hasResult(entry.path))) return false;
    change(() => {
      if (session.viewMode !== "single" || session.activeIndex !== index) options.showImage(index);
      closeTransient();
      session.propsVisible = kind === "properties";
      applyProperties();
      // 刷新目录后沿用当前条目的元数据，不展示右键菜单捕获的旧对象。
      const current = session.images[session.activeIndex];
      if (kind === "share") {
        share.panel.classList.remove("collapsed");
        share.open(current);
      } else if (kind === "ocr") ocr.open(current);
    });
    return true;
  };
  return {
    openProperties: (entry: ImageEntry) => open("properties", entry),
    openShare: (entry: ImageEntry) => open("share", entry),
    openOcr: (entry: ImageEntry) => open("ocr", entry),
    applyProperties: () => change(applyProperties),
    refreshProperties,
    closeProperties: () =>
      change(() => {
        session.propsVisible = false;
        applyProperties();
      }),
    closeShare: () => change(closeShare),
    closeOcr: () => change(closeOcr),
    closeTransient: () => change(closeTransient),
    closeAll: () =>
      change(() => {
        closeTransient();
        session.propsVisible = false;
        applyProperties();
      }),
  };
}

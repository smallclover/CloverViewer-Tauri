import { syncScreenshotWindow, type ScreenshotData } from "../api";

interface ViewportReadyOptions {
  root: HTMLElement;
  data: ScreenshotData;
  isCurrent: () => boolean;
  sync?: (captureId: number) => Promise<boolean | null>;
  pause?: () => Promise<void>;
}

/** 原生窗口、子 WebView 和 CSS 布局均对齐后，才允许展示完整桌面。 */
export async function waitForScreenshotViewport({
  root,
  data,
  isCurrent,
  sync = syncScreenshotWindow,
  pause = () => new Promise<void>((resolve) => window.setTimeout(resolve, 16)),
}: ViewportReadyOptions): Promise<boolean> {
  let previous = "";
  let observed = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!isCurrent()) return false;
    const aligned = await sync(data.capture_id);
    if (aligned === null || !isCurrent()) return false;
    const { width, height } = root.getBoundingClientRect();
    observed = `${width}x${height}, nativeAligned=${aligned}`;
    // UI 倍率和混合 DPI 可以等比缩放 CSS 尺寸，不能把宽高按不同比例挤压。
    const valid =
      aligned &&
      width > 0 &&
      height > 0 &&
      Math.abs(height - (width * data.total_height) / data.total_width) <= 2;
    const current = valid ? `${width},${height}` : "";
    if (current && current === previous) return true;
    previous = current;
    // 已对齐时以第二次 IPC 确认稳定，不等待隐藏 WebView 中可能被节流的定时器。
    if (!valid) await pause();
  }
  throw new Error(
    `Screenshot viewport did not match the captured desktop: expected ${data.total_width}x${data.total_height}, CSS ${observed}`,
  );
}

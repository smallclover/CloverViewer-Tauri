import { syncScreenshotWindow, type ScreenshotData } from "../api";

interface ViewportReadyOptions {
  root: HTMLElement;
  data: ScreenshotData;
  isCurrent: () => boolean;
  sync?: (captureId: number) => Promise<boolean | null>;
  pause?: () => Promise<void>;
  getPixelRatio?: () => number;
}

/** 原生窗口、子 WebView 和 CSS 布局均对齐后，才允许展示完整桌面。 */
export async function waitForScreenshotViewport({
  root,
  data,
  isCurrent,
  sync = syncScreenshotWindow,
  pause = () => new Promise<void>((resolve) => window.setTimeout(resolve, 16)),
  getPixelRatio = () => window.devicePixelRatio,
}: ViewportReadyOptions): Promise<boolean> {
  let previous = "";
  let observed = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!isCurrent()) return false;
    const aligned = await sync(data.capture_id);
    if (aligned === null || !isCurrent()) return false;
    const { width, height } = root.getBoundingClientRect();
    const pixelRatio = getPixelRatio();
    observed = `${width}x${height}, dpr=${pixelRatio}, nativeAligned=${aligned}`;
    // DPR 含当前 WebView 的系统 DPI 与页面倍率，仅用于校验整窗物理范围。
    // 只验宽高比会放过分辨率切换后等比缩小的旧视口；屏幕采样仍使用原始像素。
    const valid =
      aligned &&
      width > 0 &&
      height > 0 &&
      Number.isFinite(pixelRatio) &&
      pixelRatio > 0 &&
      Math.abs(width * pixelRatio - data.total_width) <= 2 &&
      Math.abs(height * pixelRatio - data.total_height) <= 2;
    const current = valid ? `${width},${height},${pixelRatio}` : "";
    if (current && current === previous) return true;
    previous = current;
    // 已对齐时以第二次 IPC 确认稳定，不等待隐藏 WebView 中可能被节流的定时器。
    if (!valid) await pause();
  }
  throw new Error(
    `Screenshot viewport did not match the captured desktop: expected ${data.total_width}x${data.total_height}, CSS ${observed}`,
  );
}

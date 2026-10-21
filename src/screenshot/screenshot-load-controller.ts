import { closeScreenshot, getScreenshotData, type ScreenshotData } from "../api";
import {
  loadScreenshotScreens,
  releaseScreenshotScreens,
  type LoadedScreenshotScreen,
} from "./screenshot-loader";
import { waitForScreenshotViewport } from "./viewport-ready";

interface ScreenshotLoadControllerOptions {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  resetSession: () => void;
  setBounds: (bounds: { totalW: number; totalH: number; minX: number; minY: number }) => void;
  setInitialCursor: (cursor: { x: number; y: number } | null) => Promise<void>;
  setScreens: (screens: LoadedScreenshotScreen[]) => void;
  render: () => void;
  restoreRunningScrollSession: () => Promise<void>;
  logLoaded: (data: ScreenshotData) => void;
}

/** 按窗口复用唯一安全的顺序加载一次截图窗口会话。 */
export function createScreenshotLoadController(options: ScreenshotLoadControllerOptions) {
  let revision = 0;
  let activeData: ScreenshotData | null = null;
  let repairing: { revision: number; result: Promise<boolean> } | null = null;
  const align = async (data: ScreenshotData, current: number) => {
    let aligned = false;
    try {
      aligned = await waitForScreenshotViewport({
        root: options.root,
        data,
        isCurrent: () => current === revision,
      });
    } catch (error) {
      console.error("Aligning screenshot viewport failed", error);
    }
    if (current !== revision) return false;
    if (!aligned) await closeScreenshot(false, data.capture_id);
    return aligned;
  };
  const load = async () => {
    const current = ++revision;
    activeData = null;
    const data = await getScreenshotData();
    // 启动预热阶段没有截图数据，保持已就绪的页面隐藏且空闲。
    if (!data || current !== revision) return null;
    let screens: LoadedScreenshotScreen[] = [];
    try {
      screens = await loadScreenshotScreens(data);
      if (!(await align(data, current))) {
        releaseScreenshotScreens(screens);
        return null;
      }
    } catch (error) {
      releaseScreenshotScreens(screens);
      if (current !== revision) return null;
      console.error("Loading screenshot pixels failed", error);
      await closeScreenshot(false, data.capture_id);
      return null;
    }
    if (current !== revision) {
      releaseScreenshotScreens(screens);
      return null;
    }
    document.body.classList.remove("ready");
    options.resetSession();
    options.setBounds({
      totalW: data.total_width,
      totalH: data.total_height,
      minX: data.min_x,
      minY: data.min_y,
    });
    options.canvas.width = data.total_width;
    options.canvas.height = data.total_height;
    options.setScreens(screens);
    await options.setInitialCursor(
      data.cursor ? { x: data.cursor.x - data.min_x, y: data.cursor.y - data.min_y } : null,
    );
    if (current !== revision) return null;
    await options.restoreRunningScrollSession();
    if (current !== revision) return null;
    // 鼠标窗口探测及滚动会话恢复都经过异步边界；显示前再核对一次。
    if (!(await align(data, current))) return null;
    options.render();
    options.logLoaded(data);
    activeData = data;
    document.body.classList.add("ready");
    return data.capture_id;
  };
  const cancel = () => {
    revision++;
    activeData = null;
  };
  const revalidate = () => {
    if (!activeData) return Promise.resolve(false);
    if (repairing?.revision === revision) return repairing.result;
    const current = revision;
    const data = activeData;
    // 显示后的 resize/DPI 消息也可能收缩视口；修复期间不要把完整桌面压进旧尺寸。
    document.body.classList.remove("ready");
    const result = align(data, current)
      .then((aligned) => {
        if (current !== revision) return false;
        if (!aligned) {
          activeData = null;
          return false;
        }
        options.render();
        document.body.classList.add("ready");
        return true;
      })
      .finally(() => {
        if (repairing?.result === result) repairing = null;
      });
    repairing = { revision: current, result };
    return result;
  };
  return { load, cancel, revalidate };
}

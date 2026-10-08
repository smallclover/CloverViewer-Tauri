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
  const load = async () => {
    const current = ++revision;
    const data = await getScreenshotData();
    // 启动预热阶段没有截图数据，保持已就绪的页面隐藏且空闲。
    if (!data || current !== revision) return null;
    let screens: LoadedScreenshotScreen[] = [];
    try {
      screens = await loadScreenshotScreens(data);
      if (
        !(await waitForScreenshotViewport({
          root: options.root,
          data,
          isCurrent: () => current === revision,
        }))
      ) {
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
    options.logLoaded(data);
    options.render();
    await options.restoreRunningScrollSession();
    if (current !== revision) return null;
    document.body.classList.add("ready");
    return data.capture_id;
  };
  const cancel = () => {
    revision++;
  };
  return { load, cancel };
}

import { closeScreenshot, getScreenshotData, type ScreenshotData } from "../api";
import {
  loadScreenshotScreens,
  releaseScreenshotScreens,
  type LoadedScreenshotScreen,
} from "./screenshot-loader";

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

/** Loads one screenshot-window session in the only safe order for window reuse. */
export function createScreenshotLoadController(options: ScreenshotLoadControllerOptions) {
  let revision = 0;
  const load = async () => {
    const current = ++revision;
    const data = await getScreenshotData();
    // Startup warmup has no capture. Keep the prepared page hidden and idle.
    if (!data || current !== revision) return null;
    let screens: LoadedScreenshotScreen[];
    try {
      screens = await loadScreenshotScreens(data);
    } catch (error) {
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

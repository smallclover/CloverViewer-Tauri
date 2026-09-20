import { closeScreenshot, getScreenshotData, type ScreenshotData } from "../api";
import { decodeScreenshotScreens, type DecodedScreenshotScreen } from "./screenshot-loader";

interface ScreenshotLoadControllerOptions {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  resetSession: () => void;
  setBounds: (bounds: { totalW: number; totalH: number; minX: number; minY: number }) => void;
  setInitialCursor: (cursor: { x: number; y: number } | null) => void;
  setScreens: (screens: DecodedScreenshotScreen[]) => void;
  render: () => void;
  restoreRunningScrollSession: () => Promise<void>;
  logLoaded: (data: ScreenshotData) => void;
}

/** Loads one screenshot-window session in the only safe order for window reuse. */
export function createScreenshotLoadController(options: ScreenshotLoadControllerOptions) {
  const load = async () => {
    const data = await getScreenshotData();
    if (!data) {
      await closeScreenshot();
      return;
    }
    document.body.classList.remove("ready");
    options.resetSession();
    options.setBounds({
      totalW: data.total_width,
      totalH: data.total_height,
      minX: data.min_x,
      minY: data.min_y,
    });
    options.setInitialCursor(
      data.cursor ? { x: data.cursor.x - data.min_x, y: data.cursor.y - data.min_y } : null,
    );
    options.canvas.width = data.total_width;
    options.canvas.height = data.total_height;
    options.setScreens(await decodeScreenshotScreens(data));
    options.logLoaded(data);
    options.render();
    await options.restoreRunningScrollSession();
    document.body.classList.add("ready");
  };
  return { load };
}

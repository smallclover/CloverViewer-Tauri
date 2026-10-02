import { getScreenshotFrame, type ScreenshotData } from "../api";
export interface LoadedScreenshotScreen {
  img: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function releaseScreenshotScreens(screens: readonly LoadedScreenshotScreen[]) {
  for (const screen of screens) {
    screen.img.width = 0;
    screen.img.height = 0;
  }
}

/** 直接上传二进制 RGBA 帧；不做 PNG 解码，也不用 Base64 字符串。 */
export async function loadScreenshotScreens(
  data: ScreenshotData,
): Promise<LoadedScreenshotScreen[]> {
  const results = await Promise.allSettled(
    data.screens.map(async (screen, index) => {
      const frame = await getScreenshotFrame(data.capture_id, index);
      const pixels = new Uint8ClampedArray(frame);
      const expected = screen.width * screen.height * 4;
      if (
        !Number.isSafeInteger(expected) ||
        screen.width <= 0 ||
        screen.height <= 0 ||
        pixels.byteLength !== expected
      ) {
        throw new Error("Invalid screenshot RGBA frame size");
      }
      const image = document.createElement("canvas");
      image.width = screen.width;
      image.height = screen.height;
      const context = image.getContext("2d");
      if (!context) throw new Error("Screenshot Canvas 2D context is unavailable");
      context.putImageData(new ImageData(pixels, screen.width, screen.height), 0, 0);
      return {
        img: image,
        x: screen.x - data.min_x,
        y: screen.y - data.min_y,
        w: screen.width,
        h: screen.height,
      };
    }),
  );
  const screens: LoadedScreenshotScreen[] = [];
  for (const result of results) if (result.status === "fulfilled") screens.push(result.value);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    releaseScreenshotScreens(screens);
    throw failed.reason;
  }
  return screens;
}

import type { ScreenshotData } from "../api";
export interface DecodedScreenshotScreen {
  img: HTMLImageElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Decodes backend screenshots and converts virtual-desktop coordinates to root-local pixels. */
export async function decodeScreenshotScreens(
  data: ScreenshotData,
): Promise<DecodedScreenshotScreen[]> {
  const screens: DecodedScreenshotScreen[] = [];
  const pending: Promise<unknown>[] = [];
  for (const screen of data.screens) {
    const image = document.createElement("img");
    image.src = screen.data_url;
    screens.push({
      img: image,
      x: screen.x - data.min_x,
      y: screen.y - data.min_y,
      w: screen.width,
      h: screen.height,
    });
    pending.push(
      typeof image.decode === "function"
        ? image.decode().catch(() => undefined)
        : new Promise((resolve) => {
            image.onload = image.onerror = () => resolve(undefined);
          }),
    );
  }
  await Promise.all(pending);
  return screens;
}

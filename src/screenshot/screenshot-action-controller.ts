import { finishScreenshot, ocrImage, startLanShare, type LanShareInfo } from "../api";
import type { Rect, Shape } from "./geometry";
import { selectionToPngBase64 } from "./selection-image";
import type { ScreenImage } from "./screen-compositor";

interface ScreenshotActionControllerOptions {
  getSelection: () => Rect | null;
  getScreens: () => readonly ScreenImage[];
  getShapes: () => readonly Shape[];
  drawShape: (context: CanvasRenderingContext2D, shape: Shape) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
  showOcr: (text: string, isError?: boolean) => void;
  showLanShare: (info: LanShareInfo) => void;
  showError: (message: string) => void;
}

/** Runs normal screenshot export and OCR without owning editor state or presentation layout. */
export function createScreenshotActionController(options: ScreenshotActionControllerOptions) {
  let ocrBusy = false;

  const validSelection = () => {
    const selection = options.getSelection();
    return selection && selection.w > 0 && selection.h > 0 ? selection : null;
  };

  const exportImage = async (action: "save" | "clipboard" | "open") => {
    const selection = validSelection();
    if (!selection) return;
    const png = await selectionToPngBase64({
      selection,
      screens: options.getScreens(),
      drawAnnotations: (context) => {
        for (const shape of options.getShapes()) options.drawShape(context, shape);
      },
    });
    await finishScreenshot(action, png);
  };

  const runOcr = async () => {
    const selection = validSelection();
    if (!selection || ocrBusy) return;

    // OCR intentionally uses the original captured image, without annotations.
    const png = await selectionToPngBase64({ selection, screens: options.getScreens() });

    ocrBusy = true;
    options.showOcr(options.translate("shot.ocrRecognizing"));
    try {
      const text = await ocrImage(png);
      options.showOcr(text.trim() || options.translate("shot.ocrEmpty"));
    } catch (error) {
      options.showOcr(options.translate("shot.ocrFailed", { msg: String(error) }), true);
    } finally {
      ocrBusy = false;
    }
  };

  const shareImage = async () => {
    const selection = validSelection();
    if (!selection) return;
    try {
      const png = await selectionToPngBase64({
        selection,
        screens: options.getScreens(),
        drawAnnotations: (context) => {
          for (const shape of options.getShapes()) options.drawShape(context, shape);
        },
      });
      options.showLanShare(await startLanShare(png));
    } catch (error) {
      options.showError(options.translate("shot.shareFailed", { msg: String(error) }));
    }
  };

  return { exportImage, runOcr, shareImage };
}

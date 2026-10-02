import {
  closeScreenshot,
  finishScreenshot,
  ocrImage,
  startLanShare,
  type LanShareInfo,
} from "../api";
import type { Rect, Shape } from "./geometry";
import { selectionToPngBase64 } from "./selection-image";
import type { ScreenImage } from "./screen-compositor";

interface ScreenshotActionControllerOptions {
  getSelection: () => Rect | null;
  getScreens: () => readonly ScreenImage[];
  getShapes: () => readonly Shape[];
  drawShape: (context: CanvasRenderingContext2D, shape: Shape) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
  setOcrBusy: (busy: boolean) => void;
  setActionBusy: (busy: boolean) => void;
  showNotice: (message: string, kind: "progress" | "success" | "error") => void;
  showLanShare: (info: LanShareInfo) => void;
}

/** 只负责常规截图导出与 OCR，不持有编辑器状态或界面布局。 */
export function createScreenshotActionController(options: ScreenshotActionControllerOptions) {
  let busy = false;
  let generation = 0;

  const validSelection = () => {
    const selection = options.getSelection();
    return selection && selection.w > 0 && selection.h > 0 ? selection : null;
  };

  const exportImage = async (action: "save" | "clipboard" | "open") => {
    const selection = validSelection();
    if (!selection || busy) return;
    busy = true;
    const current = generation;
    options.setActionBusy(true);
    options.showNotice(
      options.translate(
        action === "save"
          ? "shot.saving"
          : action === "clipboard"
            ? "shot.copying"
            : "shot.openingViewer",
      ),
      "progress",
    );
    try {
      const png = await selectionToPngBase64({
        selection,
        screens: options.getScreens(),
        drawAnnotations: (context) => {
          for (const shape of options.getShapes()) options.drawShape(context, shape);
        },
      });
      if (current !== generation) return;
      await finishScreenshot(action, png, undefined, action !== "open");
      if (current !== generation || action === "open") return;
      options.showNotice(
        options.translate(action === "save" ? "shot.saveSuccess" : "shot.copySuccess"),
        "success",
      );
      await new Promise<void>((resolve) => window.setTimeout(resolve, 550));
      if (current === generation) await closeScreenshot(true);
    } catch (error) {
      if (current !== generation) return;
      options.showNotice(
        options.translate(
          action === "save"
            ? "shot.saveFailed"
            : action === "clipboard"
              ? "shot.copyFailed"
              : "shot.openFailed",
          { msg: String(error) },
        ),
        "error",
      );
    } finally {
      if (current === generation) {
        busy = false;
        options.setActionBusy(false);
      }
    }
  };

  const runOcr = async () => {
    const selection = validSelection();
    if (!selection || busy) return;

    busy = true;
    const current = generation;
    options.setActionBusy(true);
    options.setOcrBusy(true);
    options.showNotice(options.translate("shot.ocrRecognizing"), "progress");
    try {
      // OCR 使用未叠加标注的选区，同样的像素会在查看器中打开。
      const png = await selectionToPngBase64({ selection, screens: options.getScreens() });
      if (current !== generation) return;
      const text = (await ocrImage(png)).trim();
      if (current !== generation) return;
      if (!text) {
        options.showNotice(options.translate("shot.ocrEmpty"), "error");
        return;
      }
      options.showNotice(options.translate("shot.ocrOpeningViewer"), "progress");
      await finishScreenshot("open", png, text);
    } catch (error) {
      if (current !== generation) return;
      options.showNotice(options.translate("shot.ocrFailed", { msg: String(error) }), "error");
    } finally {
      if (current === generation) {
        busy = false;
        options.setActionBusy(false);
        options.setOcrBusy(false);
      }
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
      options.showNotice(options.translate("shot.shareFailed", { msg: String(error) }), "error");
    }
  };

  const reset = () => {
    generation++;
    busy = false;
    options.setActionBusy(false);
    options.setOcrBusy(false);
  };

  return { exportImage, runOcr, shareImage, reset };
}

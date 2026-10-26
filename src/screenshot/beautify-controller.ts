import { finishScreenshot, getBeautifyLibrary, type BeautifyDocument } from "../api";
import { cloneBeauty } from "../image-beautify/model";
import { allBuiltinPresets } from "../image-beautify/presets";
import { composeBeauty } from "../image-beautify/renderer";
import { checkBeautySize } from "../image-beautify/layout";
import type { Translate } from "../image-beautify/controls";
import { selectionCanvasToBase64 } from "./selection-image";

export function createScreenshotBeauty(options: {
  getDocument: () => BeautifyDocument;
  setDocument: (value: BeautifyDocument, checkpoint?: boolean) => void;
  compose: (preview?: boolean) => HTMLCanvasElement;
  prepare: () => void;
  t: Translate;
  changed: () => void;
  fail: (message: string) => void;
  setBusy: (busy: boolean) => void;
}) {
  let generation = 0,
    time = new Date(),
    ready = Promise.resolve();
  let opening = false;
  const error = (value: unknown) => {
    const message = value instanceof Error ? value.message : String(value);
    options.fail(
      message.startsWith("beautify.")
        ? options.t(message)
        : options.t("beautify.failed", { msg: message }),
    );
  };
  return {
    reset() {
      generation++;
      time = new Date();
      opening = false;
      options.setBusy(false);
      const current = generation;
      ready = getBeautifyLibrary()
        .then((library) => {
          if (current !== generation || !library.autoApply || options.getDocument().enabled) return;
          const preset = [...allBuiltinPresets(), ...library.presets].find(
            (p) => p.id === library.defaultPresetId,
          );
          if (preset) {
            options.setDocument(cloneBeauty(preset.document), false);
            options.changed();
          }
        })
        .catch((e) => {
          if (current === generation) error(e);
        });
    },
    async open() {
      if (opening) return;
      opening = true;
      options.setBusy(true);
      const current = generation;
      let source: HTMLCanvasElement | null = null;
      try {
        await ready;
        if (current !== generation) return;
        options.prepare();
        source = options.compose(true);
        checkBeautySize(source.width, source.height);
        const context = {
          document: cloneBeauty(options.getDocument()),
          capturedAt: time.getTime(),
        };
        const png = await selectionCanvasToBase64(source);
        if (current !== generation) return;
        await finishScreenshot("open", png, undefined, false, undefined, context);
      } catch (e) {
        if (source) source.width = source.height = 0;
        if (current === generation) error(e);
      } finally {
        if (current === generation) {
          opening = false;
          options.setBusy(false);
        }
      }
    },
    async output() {
      const current = generation;
      await ready;
      if (current !== generation) throw new Error("Screenshot changed");
      options.prepare();
      const document = cloneBeauty(options.getDocument()),
        capturedTime = time;
      const source = options.compose();
      if (!document.enabled) return selectionCanvasToBase64(source);
      return selectionCanvasToBase64(await composeBeauty(source, document, capturedTime));
    },
    isOpen: () => opening,
  };
}

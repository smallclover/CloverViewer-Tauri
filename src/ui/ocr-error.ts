/** Translate stable backend OCR error codes; keep unexpected diagnostics available. */
export function ocrErrorMessage(error: unknown, translate: (key: string) => string): string {
  const message = String(error);
  const codes: Record<string, string> = {
    OCR_LANGUAGE_UNAVAILABLE: "ocr.error.language",
    OCR_MODEL_MISSING: "ocr.error.missing",
    OCR_MODEL_CORRUPT: "ocr.error.corrupt",
    OCR_MODEL_BUSY: "ocr.error.busy",
    OCR_WORKER_FAILED: "ocr.error.worker",
    OCR_UNSUPPORTED: "ocr.error.unsupported",
    OCR_INPUT_TOO_LARGE: "ocr.error.large",
  };
  for (const [code, key] of Object.entries(codes)) {
    if (message.includes(code)) return translate(key);
  }
  return message;
}

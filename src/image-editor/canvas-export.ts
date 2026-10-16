export function canvasPng(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Canvas export failed"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }, "image/png");
  }).finally(() => {
    canvas.width = canvas.height = 0;
  });
}

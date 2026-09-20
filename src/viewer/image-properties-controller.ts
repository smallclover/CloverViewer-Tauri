import type { ExifInfo, ImageEntry } from "../api";

interface ImagePropertiesControllerOptions {
  list: HTMLElement;
  getImageInfo: (path: string) => Promise<ExifInfo>;
  formatDimensions: (width: number, height: number) => string;
  formatSize: (size: number) => string;
  translate: (key: string) => string;
}

/** Renders basic image metadata immediately, then appends EXIF details for the current image only. */
export function createImagePropertiesController(options: ImagePropertiesControllerOptions) {
  let token = 0;

  const appendRow = (labelText: string, valueText: string) => {
    const row = document.createElement("div");
    row.className = "prop-row";
    const label = document.createElement("div");
    label.className = "prop-label";
    label.textContent = labelText;
    const value = document.createElement("div");
    value.className = "prop-value";
    value.textContent = valueText;
    value.title = valueText;
    row.append(label, value);
    options.list.appendChild(row);
  };

  const render = (entry: ImageEntry) => {
    const currentToken = ++token;
    options.list.innerHTML = "";
    const modified = entry.modified ? new Date(entry.modified).toLocaleString() : "—";
    const rows: [string, string][] = [
      [options.translate("prop.filename"), entry.name],
      [options.translate("prop.path"), entry.path],
      [options.translate("prop.dimensions"), options.formatDimensions(entry.width, entry.height)],
      [options.translate("prop.size"), options.formatSize(entry.size)],
      [options.translate("prop.modified"), modified],
      [options.translate("prop.format"), entry.path.split(".").pop()?.toUpperCase() ?? "—"],
    ];
    for (const [label, value] of rows) appendRow(label, value);

    void options
      .getImageInfo(entry.path)
      .then((info) => {
        if (currentToken !== token) return;
        const exifRows: [string, string][] = [
          [options.translate("prop.datetime"), info.datetime],
          [options.translate("prop.camera"), [info.make, info.model].filter(Boolean).join(" ")],
          [options.translate("prop.iso"), info.iso],
          [options.translate("prop.aperture"), info.f_number],
          [options.translate("prop.shutter"), info.exposure_time],
          [options.translate("prop.focal"), info.focal_length],
          [options.translate("prop.lens"), info.lens_model],
        ];
        for (const [label, value] of exifRows) {
          if (value) appendRow(label, value);
        }
      })
      .catch(() => {});
  };

  return { render };
}

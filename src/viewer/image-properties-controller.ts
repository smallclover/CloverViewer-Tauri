import type { ExifInfo, ImageEntry } from "../api";

interface ImagePropertiesControllerOptions {
  list: HTMLElement;
  getImageInfo: (path: string) => Promise<ExifInfo>;
  formatDimensions: (width: number, height: number) => string;
  formatSize: (size: number) => string;
  translate: (key: string) => string;
}

/** Renders grouped file details immediately, then adds EXIF metadata for the current image only. */
export function createImagePropertiesController(options: ImagePropertiesControllerOptions) {
  let token = 0;

  const createSection = (labelText: string) => {
    const section = document.createElement("section");
    section.className = "prop-section";
    const label = document.createElement("h4");
    label.className = "prop-section-title";
    label.textContent = labelText;
    section.appendChild(label);
    options.list.appendChild(section);
    return section;
  };

  const appendInfo = (container: HTMLElement, labelText: string, valueText: string) => {
    const card = document.createElement("div");
    card.className = "prop-info";
    const label = document.createElement("span");
    label.textContent = labelText;
    const value = document.createElement("strong");
    value.textContent = valueText;
    value.title = valueText;
    card.append(label, value);
    container.appendChild(card);
  };

  const render = (entry: ImageEntry) => {
    const currentToken = ++token;
    options.list.innerHTML = "";
    const modified = entry.modified ? new Date(entry.modified).toLocaleString() : "—";

    const fileSection = createSection(options.translate("props.sectionFile"));
    const fileCard = document.createElement("div");
    fileCard.className = "prop-file-card";
    const name = document.createElement("div");
    name.className = "prop-file-name";
    name.textContent = entry.name;
    name.title = entry.name;
    fileCard.appendChild(name);
    fileSection.appendChild(fileCard);

    const imageSection = createSection(options.translate("props.sectionImage"));
    const infoGrid = document.createElement("div");
    infoGrid.className = "prop-info-grid";
    appendInfo(
      infoGrid,
      options.translate("prop.dimensions"),
      options.formatDimensions(entry.width, entry.height),
    );
    appendInfo(infoGrid, options.translate("prop.size"), options.formatSize(entry.size));
    appendInfo(
      infoGrid,
      options.translate("prop.format"),
      entry.path.split(".").pop()?.toUpperCase() ?? "—",
    );
    imageSection.appendChild(infoGrid);

    const timeSection = createSection(options.translate("props.sectionTime"));
    const timeCard = document.createElement("div");
    timeCard.className = "prop-time-card";
    appendInfo(timeCard, options.translate("prop.modified"), modified);
    timeSection.appendChild(timeCard);

    void options
      .getImageInfo(entry.path)
      .then((info) => {
        if (currentToken !== token) return;
        const availableRows = (
          [
            [options.translate("prop.datetime"), info.datetime],
            [options.translate("prop.camera"), [info.make, info.model].filter(Boolean).join(" ")],
            [options.translate("prop.iso"), info.iso],
            [options.translate("prop.aperture"), info.f_number],
            [options.translate("prop.shutter"), info.exposure_time],
            [options.translate("prop.focal"), info.focal_length],
            [options.translate("prop.lens"), info.lens_model],
          ] satisfies [string, string][]
        ).filter(([, value]) => value);
        if (availableRows.length === 0) return;

        const exifSection = createSection(options.translate("props.sectionExif"));
        const detailList = document.createElement("div");
        detailList.className = "prop-detail-list";
        for (const [labelText, valueText] of availableRows) {
          const row = document.createElement("div");
          row.className = "prop-detail-row";
          const label = document.createElement("span");
          label.textContent = labelText;
          const value = document.createElement("strong");
          value.textContent = valueText;
          value.title = valueText;
          row.append(label, value);
          detailList.appendChild(row);
        }
        exifSection.appendChild(detailList);
      })
      .catch(() => {});
  };

  return { render };
}

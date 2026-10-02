import type { ExifInfo, ImageEntry } from "../api";

interface ImagePropertiesControllerOptions {
  list: HTMLElement;
  getImageInfo: (path: string) => Promise<ExifInfo>;
  formatDimensions: (width: number, height: number) => string;
  formatSize: (size: number) => string;
  openContainingFolder: (path: string) => Promise<void>;
  onOpenFolderError: (error: unknown) => void;
  translate: (key: string) => string;
}

/** 分组的基本文件信息立即渲染，EXIF 只异步补当前这一张（token 作废过期结果）。 */
export function createImagePropertiesController(options: ImagePropertiesControllerOptions) {
  let token = 0;
  const iconPaths = {
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><circle cx="9" cy="14" r="1"/><path d="m6 19 3-3 2 2 3-4 3 5"/>',
    image:
      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    exif: '<path d="M4 7h4l2-3h4l2 3h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/><circle cx="12" cy="13" r="3"/>',
    external:
      '<path d="M13 5h6v6"/><path d="m19 5-9 9"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  } as const;

  const createIcon = (kind: keyof typeof iconPaths) => {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = iconPaths[kind];
    return icon;
  };

  const createSection = (labelText: string, iconKind: keyof typeof iconPaths) => {
    const section = document.createElement("section");
    section.className = "prop-section";
    const label = document.createElement("h4");
    label.className = "prop-section-title";
    const icon = createIcon(iconKind);
    icon.classList.add("prop-section-icon");
    const text = document.createElement("span");
    text.textContent = labelText;
    label.append(icon, text);
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

    const fileSection = createSection(options.translate("props.sectionFile"), "file");
    const fileCard = document.createElement("div");
    fileCard.className = "prop-file-card";
    const nameLabel = document.createElement("span");
    nameLabel.className = "prop-file-label";
    nameLabel.textContent = options.translate("prop.filename");
    const name = document.createElement("div");
    name.className = "prop-file-name";
    name.textContent = entry.name;
    name.title = entry.name;
    const pathLabel = document.createElement("span");
    pathLabel.className = "prop-file-label";
    pathLabel.textContent = options.translate("prop.path");
    const pathButton = document.createElement("button");
    pathButton.className = "prop-file-path";
    pathButton.type = "button";
    const pathText = document.createElement("span");
    pathText.textContent = entry.path;
    const pathIcon = createIcon("external");
    pathIcon.classList.add("prop-file-path-icon");
    pathButton.append(pathText, pathIcon);
    pathButton.title = options.translate("prop.openFolder");
    pathButton.setAttribute("aria-label", `${options.translate("prop.openFolder")}: ${entry.path}`);
    pathButton.addEventListener("click", () => {
      void options.openContainingFolder(entry.path).catch(options.onOpenFolderError);
    });
    fileCard.append(nameLabel, name, pathLabel, pathButton);
    fileSection.appendChild(fileCard);

    const imageSection = createSection(options.translate("props.sectionImage"), "image");
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

    const timeSection = createSection(options.translate("props.sectionTime"), "time");
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

        const exifSection = createSection(options.translate("props.sectionExif"), "exif");
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

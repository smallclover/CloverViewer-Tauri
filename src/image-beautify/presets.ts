import type { BeautifyLibrary, BeautifyPreset } from "../api";
import { defaultFrameStyle, emptyBeauty, migrateBeauty, newWatermark, frameStyle } from "./model";

export const emptyLibrary = (): BeautifyLibrary => ({
  schema: 3,
  revision: 0,
  autoApply: false,
  defaultPresetId: "mac-light",
  lastPresetId: "mac-light",
  presets: [],
});

export function legacyPresets(): BeautifyPreset[] {
  const clean = emptyBeauty();
  clean.enabled = true;
  clean.frame.kind = "solid";
  const gradient = structuredClone(clean);
  gradient.frame.kind = "gradient";
  gradient.frame.background = "#dbeafe";
  gradient.frame.backgroundEnd = "#d8b4fe";
  gradient.frame.padding = [80, 80, 80, 80];
  const brand = structuredClone(clean);
  brand.frame.padding[2] = 120;
  const logo = newWatermark("image");
  logo.region = "bottom";
  logo.anchor = 4;
  logo.x = logo.y = 0;
  logo.opacity = 1;
  brand.watermarks = [logo];
  const marked = emptyBeauty();
  marked.enabled = true;
  const text = newWatermark("text");
  text.placement = "tile";
  text.rotation = -30;
  text.opacity = 0.2;
  text.color = "#555555";
  text.outline = 0;
  marked.watermarks = [text];
  return [
    { id: "clean", name: "beautify.presetClean", document: migrateBeauty(clean) },
    { id: "gradient", name: "beautify.presetGradient", document: migrateBeauty(gradient) },
    { id: "brand", name: "beautify.presetBrand", document: migrateBeauty(brand) },
    { id: "marked", name: "beautify.presetMarked", document: migrateBeauty(marked) },
  ];
}

export function builtinPresets(): BeautifyPreset[] {
  const create = (
    id: BeautifyPreset["document"]["frame"]["kind"],
    name: string,
    start: string,
    end = start,
  ): BeautifyPreset => {
    const document = emptyBeauty();
    document.enabled = true;
    document.frame.kind = id;
    document.frame.style = defaultFrameStyle();
    document.frame.padding = [80, 80, 80, 80];
    document.frame.radius = 24;
    document.frame.shadow = 22;
    document.frame.borderColor = "#c2ccc7";
    document.background = {
      kind: start === end ? "solid" : "gradient",
      color: start,
      endColor: end,
      angle: 125,
    };
    return { id, name: `beautify.${name}`, document };
  };
  const light = create("mac-light", "presetMacLight", "#e2eee6", "#bbd0c5");
  const dark = create("mac-dark", "presetMacDark", "#344854", "#17282f");
  dark.document.frame.borderColor = "#505b62";
  const browser = create("browser", "presetBrowser", "#e2e9f1", "#bdcddd");
  browser.document.frame.style = {
    ...frameStyle(browser.document.frame),
    titleBarHeight: 80,
    url: "example.com",
  };
  const gallery = create("gallery", "presetGallery", "#e8e5df");
  Object.assign(gallery.document.frame, {
    borderColor: "#242923",
    shadow: 16,
    padding: [64, 64, 64, 64],
  });
  gallery.document.frame.style = {
    ...frameStyle(gallery.document.frame),
    railWidth: 44,
    matWidth: 120,
    innerWidth: 4,
    matColor: "#f4f1e9",
    accentColor: "#b6afa0",
  };
  const wood = create("wood", "presetWood", "#eae5dc");
  Object.assign(wood.document.frame, {
    borderColor: "#c69b69",
    shadow: 16,
    padding: [64, 64, 64, 64],
  });
  wood.document.frame.style = {
    ...frameStyle(wood.document.frame),
    railWidth: 56,
    matWidth: 112,
    innerWidth: 6,
    matColor: "#f4eee1",
    accentColor: "#baa98c",
  };
  const paper = create("polaroid", "presetPolaroid", "#e2e9e2", "#c8d5ce");
  Object.assign(paper.document.frame, { shadow: 18, padding: [72, 72, 72, 72] });
  paper.document.frame.style = {
    ...frameStyle(paper.document.frame),
    matWidth: 44,
    paperBottom: 210,
    matColor: "#fffdf7",
    accentColor: "#777c70",
    captionDate: true,
  };
  return [light, dark, browser, gallery, wood, paper];
}

/** Old IDs remain resolvable for saved defaults; the main gallery features the six new styles. */
export const allBuiltinPresets = () => [...builtinPresets(), ...legacyPresets()];

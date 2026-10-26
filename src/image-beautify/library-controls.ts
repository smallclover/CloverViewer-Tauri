import {
  getBeautifyLibrary,
  saveBeautifyLibrary,
  type BeautifyLibrary,
  type BeautifyDocument,
} from "../api";
import { button, field, type Translate } from "./controls";
import { beautyKey, cloneBeauty, rebaseBeauty } from "./model";
import { allBuiltinPresets, builtinPresets, emptyLibrary, legacyPresets } from "./presets";

export function createLibraryControls(options: {
  t: Translate;
  fail: (error: unknown) => void;
  refresh: () => void;
  getDocument: () => BeautifyDocument;
  apply: (value: BeautifyDocument) => void;
  active: () => boolean;
  thumbnail: (target: HTMLCanvasElement, beauty: BeautifyDocument) => void;
  adjustments: (parent: HTMLElement) => void;
}) {
  let library = emptyLibrary(),
    selected = "",
    loaded = false,
    busy = false,
    name = "",
    custom = false,
    category = "screenshots";
  const builtins = [legacyPresets()[0], ...builtinPresets()];
  const all = () => [...allBuiltinPresets(), ...library.presets];
  const builtinIds = new Set(allBuiltinPresets().map((p) => p.id));
  const persist = async (update: (next: BeautifyLibrary) => void) => {
    if (busy || !loaded) return;
    busy = true;
    const next = structuredClone(library);
    update(next);
    options.refresh();
    try {
      library = await saveBeautifyLibrary(next, library.revision);
    } catch (error) {
      options.fail(error);
      if (String(error).includes("beautify.conflict")) {
        try {
          library = await getBeautifyLibrary();
        } catch (refreshError) {
          loaded = false;
          options.fail(refreshError);
        }
      }
    } finally {
      busy = false;
      if (options.active()) options.refresh();
    }
  };
  return {
    sync() {
      const current = options.getDocument(),
        key = beautyKey(current);
      const preset = all().find(
        (p) =>
          beautyKey(rebaseBeauty(p.document, current.referenceSize, current.referenceSize)) === key,
      );
      custom = !preset;
      if (preset) {
        selected = preset.id;
        name = builtinIds.has(preset.id) ? "" : preset.name;
      }
    },
    async load() {
      try {
        library = await getBeautifyLibrary();
        loaded = true;
        selected = library.lastPresetId;
        name = library.presets.find((p) => p.id === selected)?.name ?? "";
      } catch (error) {
        options.fail(error);
      }
      if (options.active()) options.refresh();
    },
    render(parent: HTMLElement) {
      const filters = document.createElement("div");
      filters.className = "beautify-preset-filters";
      parent.append(filters);
      for (const key of ["all", "screenshots", "photos", "personal"]) {
        const node = button(filters, options.t(`beautify.category${key}`), () => {
          category = key;
          options.refresh();
        });
        node.setAttribute("aria-pressed", String(category === key));
      }
      const grid = document.createElement("div");
      grid.className = "beautify-preset-grid";
      parent.append(grid);
      const visible = [...builtins, ...library.presets].filter(
        (preset) =>
          category === "all" ||
          (category === "personal"
            ? !builtinIds.has(preset.id)
            : category === "screenshots"
              ? ["clean", "mac-light", "mac-dark", "browser"].includes(preset.id)
              : ["gallery", "wood", "polaroid"].includes(preset.id)),
      );
      if (!visible.length) {
        const hint = document.createElement("small");
        hint.textContent = options.t("beautify.noPersonalPresets");
        grid.append(hint);
      }
      for (const preset of visible) {
        const node = button(
          grid,
          builtins.includes(preset) ? options.t(preset.name) : preset.name,
          () => {
            selected = preset.id;
            custom = false;
            name = builtins.includes(preset) ? "" : preset.name;
            options.apply(preset.document);
            void persist((next) => {
              next.lastPresetId = selected;
            });
          },
        );
        node.classList.add("beautify-preset-card");
        const caption = document.createElement("span");
        caption.className = "beautify-preset-name";
        caption.textContent = node.textContent;
        const thumbnail = document.createElement("span");
        thumbnail.className = "beautify-preset-image";
        thumbnail.ariaHidden = "true";
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        thumbnail.append(canvas);
        options.thumbnail(canvas, preset.document);
        node.replaceChildren(thumbnail, caption);
        node.ariaLabel = caption.textContent;
        node.classList.toggle("primary", !custom && selected === preset.id);
      }
      options.adjustments(parent);
      const personalSettings = document.createElement("details");
      personalSettings.className = "beautify-preferences";
      personalSettings.open = category === "personal";
      const personalSummary = document.createElement("summary");
      personalSummary.textContent = options.t("beautify.personalSettings");
      const personalBody = document.createElement("div");
      personalBody.className = "beautify-preferences-body";
      personalSettings.append(personalSummary, personalBody);
      parent.append(personalSettings);
      field(
        personalBody,
        options.t("beautify.presetName"),
        name,
        (v) => {
          name = v;
        },
        "text",
      );
      if (custom) {
        const hint = document.createElement("small");
        hint.textContent = options.t("beautify.custom");
        personalBody.append(hint);
      }
      const actions = document.createElement("div");
      actions.className = "beautify-row beautify-preset-actions";
      personalBody.append(actions);
      const save = (replace: boolean) => {
        if (!name.trim() || [...name.trim()].length > 80) {
          options.fail(new Error("beautify.invalidName"));
          return;
        }
        const id = replace ? selected : crypto.randomUUID();
        void persist((next) => {
          const preset = { id, name: name.trim(), document: cloneBeauty(options.getDocument()) };
          const index = next.presets.findIndex((p) => p.id === id);
          if (index < 0) next.presets.push(preset);
          else next.presets[index] = preset;
          next.lastPresetId = id;
          selected = id;
          custom = false;
        });
      };
      button(actions, options.t("beautify.savePreset"), () => save(false)).disabled =
        busy || !loaded;
      const personal = library.presets.some((p) => p.id === selected);
      button(actions, options.t("beautify.updatePreset"), () => save(true)).disabled =
        busy || !loaded || !personal;
      button(
        actions,
        options.t("beautify.delete"),
        () =>
          void persist((next) => {
            next.presets = next.presets.filter((p) => p.id !== selected);
            if (next.defaultPresetId === selected) {
              next.defaultPresetId = "mac-light";
              next.autoApply = false;
            }
            next.lastPresetId = "mac-light";
            selected = "";
          }),
      ).disabled = busy || !loaded || !personal;
      const preferences = document.createElement("details");
      preferences.className = "beautify-preferences";
      const summary = document.createElement("summary");
      summary.textContent = options.t("beautify.presetSettings");
      const preferencesBody = document.createElement("div");
      preferencesBody.className = "beautify-preferences-body";
      preferences.append(summary, preferencesBody);
      parent.append(preferences);
      const auto = field(
        preferencesBody,
        options.t("beautify.autoApply"),
        library.autoApply,
        (v) =>
          void persist((next) => {
            next.autoApply = v === "true";
          }),
        "checkbox",
      );
      auto.disabled = busy || !loaded;
      const defaults = field(
        preferencesBody,
        options.t("beautify.defaultPreset"),
        library.defaultPresetId,
        (v) =>
          void persist((next) => {
            next.defaultPresetId = v;
          }),
        "text",
        all().map((p) => [p.id, builtinIds.has(p.id) ? options.t(p.name) : p.name]),
      );
      defaults.disabled = busy || !loaded;
      const hint = document.createElement("small");
      hint.textContent = options.t("beautify.presetHint");
      preferencesBody.append(hint);
    },
    customized() {
      custom = true;
    },
  };
}

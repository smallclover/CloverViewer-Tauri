import type { BeautifyDocument, BeautifyWatermark } from "../api";
import { importBeautifyAsset } from "../api";
import { open } from "@tauri-apps/plugin-dialog";
import { newWatermark } from "./model";

export type Translate = (key: string, params?: Record<string, string | number>) => string;
export interface Controls {
  parent: HTMLElement;
  t: Translate;
  document: BeautifyDocument;
  edit: (update: (value: BeautifyDocument) => void, key?: string) => void;
  rebuild: () => void;
  fail: (error: unknown) => void;
  active: () => boolean;
}

export function button(parent: HTMLElement, label: string, action: () => void) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "floating-action";
  node.textContent = label;
  node.addEventListener("click", action);
  parent.append(node);
  return node;
}

export function field(
  parent: HTMLElement,
  label: string,
  value: string | number | boolean,
  change: (value: string) => void,
  type = "number",
  choices?: [string, string][],
  min = 0,
  max = 32767,
) {
  const row = document.createElement("label");
  row.className = "beautify-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = choices ? document.createElement("select") : document.createElement("input");
  if (input instanceof HTMLSelectElement) {
    for (const [id, label] of choices ?? []) input.append(new Option(label, id));
  } else {
    input.type = type;
    input.min = String(min);
    input.max = String(max);
    input.step = "any";
  }
  if (input instanceof HTMLInputElement && type === "checkbox") input.checked = !!value;
  else input.value = String(value);
  const update = () => {
    if (
      input instanceof HTMLInputElement &&
      type === "number" &&
      (!input.value || !input.checkValidity())
    )
      return;
    change(
      input instanceof HTMLInputElement && type === "checkbox"
        ? String(input.checked)
        : input.value,
    );
  };
  input.addEventListener(choices ? "change" : "input", update);
  row.append(caption, input);
  parent.append(row);
  return input;
}

export function slider(
  parent: HTMLElement,
  label: string,
  value: number,
  change: (value: string) => void,
  max: number,
  min = 0,
  step = 1,
  strict = false,
) {
  const input = field(
    parent,
    label,
    Math.round(value * 100) / 100,
    change,
    "number",
    undefined,
    min,
    max === 1 || max === 360 || strict ? max : 32767,
  );
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(Math.max(max, value));
  range.step = String(step);
  range.value = String(value);
  range.ariaLabel = label;
  range.addEventListener("input", () => {
    input.value = range.value;
    change(range.value);
  });
  input.addEventListener("input", () => {
    if (input instanceof HTMLInputElement && !input.checkValidity()) return;
    range.max = String(Math.max(max, Number(input.value)));
    range.value = input.value;
  });
  input.parentElement?.classList.add("beautify-slider");
  input.parentElement?.append(range);
}

export function watermarkControls(c: Controls, selected: string, select: (id: string) => void) {
  const actions = document.createElement("div");
  actions.className = "beautify-row";
  c.parent.append(actions);
  for (const kind of ["text", "image"] as const) {
    button(actions, c.t(`beautify.add${kind}`), () => {
      const existing = c.document.watermarks.find((w) => w.kind === kind);
      if (existing) {
        select(existing.id);
        return;
      }
      if (c.document.watermarks.length >= 8) return;
      const layer = newWatermark(kind);
      const factor = c.document.referenceSize / 1000;
      for (const key of ["fontSize", "outline", "x", "y", "width", "gapX", "gapY"] as const)
        layer[key] *= factor;
      c.edit((d) => {
        d.enabled = true;
        d.watermarks.push(layer);
      });
      select(layer.id);
    }).disabled = c.document.watermarks.length >= 8;
  }
  const layer = c.document.watermarks.find((w) => w.id === selected);
  const layers = document.createElement("div");
  layers.className = "beautify-layer-list";
  c.parent.append(layers);
  for (const [i, w] of c.document.watermarks.entries()) {
    const node = button(
      c.parent,
      `${i + 1}. ${w.kind === "text" ? w.text.slice(0, 30) : c.t("beautify.logo")}`,
      () => select(w.id),
    );
    node.classList.toggle("primary", w.id === selected);
    layers.append(node);
    node.classList.add("beautify-layer");
    const icon = document.createElement("span");
    icon.className = "beautify-layer-icon";
    icon.textContent = w.kind === "text" ? "T" : "◈";
    icon.ariaHidden = "true";
    node.prepend(icon);
    node.setAttribute("aria-pressed", String(w.id === selected));
  }
  if (!layer) {
    const empty = document.createElement("p");
    empty.className = "beautify-empty";
    empty.textContent = c.t("beautify.watermarkHint");
    c.parent.append(empty);
    return;
  }
  const set = <K extends keyof BeautifyWatermark>(key: K, value: BeautifyWatermark[K]) =>
    c.edit((d) => {
      const current = d.watermarks.find((w) => w.id === layer.id);
      if (current) current[key] = value;
    }, `watermark.${layer.id}.${key}`);
  field(
    c.parent,
    c.t("beautify.layerEnabled"),
    layer.enabled,
    (v) => set("enabled", v === "true"),
    "checkbox",
  );
  if (layer.kind === "text") {
    const text = document.createElement("textarea");
    text.value = layer.text;
    text.maxLength = 2000;
    text.ariaLabel = c.t("beautify.text");
    text.rows = 3;
    text.addEventListener("input", () => set("text", text.value));
    c.parent.append(text);
    const hint = document.createElement("small");
    hint.textContent = c.t("beautify.variables");
    c.parent.append(hint);
    field(c.parent, c.t("shot.color"), layer.color, (v) => set("color", v), "color");
  } else {
    button(
      c.parent,
      c.t("beautify.importLogo"),
      () =>
        void (async () => {
          const path = await open({
            multiple: false,
            filters: [{ name: "PNG", extensions: ["png"] }],
          });
          if (!path || !c.active()) return;
          const id = await importBeautifyAsset(path);
          if (!c.active()) return;
          set("assetId", id);
          c.rebuild();
        })().catch(c.fail),
    );
    if (!layer.assetId) {
      const hint = document.createElement("small");
      hint.textContent = c.t("beautify.missingAsset");
      c.parent.append(hint);
    }
  }
  {
    const anchors = document.createElement("div");
    anchors.className = "beautify-anchor-grid";
    anchors.setAttribute("role", "group");
    anchors.ariaLabel = c.t("beautify.anchor");
    c.parent.append(anchors);
    for (let anchor = 0; anchor < 9; anchor++) {
      const node = button(anchors, c.t(`beautify.anchor${anchor}`), () => {
        c.edit((d) => {
          const current = d.watermarks.find((w) => w.id === layer.id);
          if (!current) return;
          current.anchor = anchor;
          current.placement = "single";
          current.region = "content";
          current.rotation = 0;
          const margin = (20 * d.referenceSize) / 1000;
          current.x = anchor % 3 === 1 ? 0 : margin * (anchor % 3 === 0 ? 1 : -1);
          current.y = Math.floor(anchor / 3) === 1 ? 0 : margin * (anchor < 3 ? 1 : -1);
        });
        c.rebuild();
      });
      node.ariaLabel = node.textContent;
      node.title = node.textContent;
      node.textContent = "";
      node.setAttribute("aria-pressed", String(layer.anchor === anchor));
    }
  }
  const key = layer.kind === "text" ? "fontSize" : "width";
  const factor = c.document.referenceSize / 1000;
  slider(
    c.parent,
    c.t(`beautify.${key}`),
    layer[key],
    (v) => set(key, Number(v)),
    Math.max(layer[key], (key === "fontSize" ? 96 : 500) * factor),
    Math.min(layer[key], 8 * factor),
    1,
  );
  slider(
    c.parent,
    c.t("beautify.opacityPercent"),
    layer.opacity * 100,
    (v) => set("opacity", Number(v) / 100),
    100,
    0,
    1,
    true,
  );
  const order = document.createElement("div");
  order.className = "beautify-row";
  c.parent.append(order);
  button(order, c.t("beautify.delete"), () => {
    c.edit((d) => {
      d.watermarks = d.watermarks.filter((w) => w.id !== layer.id);
    });
    select("");
  });
}

import { button, field, type Controls } from "./controls";
import { beautyBackground, migrateBeauty } from "./model";

const backgrounds = [
  ["transparent", "transparent", "#ffffff", "#ffffff"],
  ["white", "solid", "#ffffff", "#ffffff"],
  ["slate", "solid", "#27343d", "#27343d"],
  ["mint", "gradient", "#e2eee6", "#bbd0c5"],
  ["blue", "gradient", "#e2e9f1", "#bdcddd"],
  ["rose", "gradient", "#f5e6e8", "#d9c7e3"],
] as const;

/** Frame geometry belongs to presets; quick adjustments only change background and spacing. */
export function frameControls(c: Controls) {
  const section = (key: string) => {
    const title = document.createElement("h3");
    title.className = "beautify-section-title";
    title.textContent = c.t(`beautify.${key}`);
    c.parent.append(title);
  };
  const bg = beautyBackground(c.document);
  section("backgroundStyle");
  const palette = document.createElement("div");
  palette.className = "beautify-backgrounds";
  palette.setAttribute("role", "group");
  palette.ariaLabel = c.t("beautify.backgroundStyle");
  c.parent.append(palette);
  for (const [name, kind, color, endColor] of backgrounds) {
    const node = button(palette, c.t(`beautify.bg.${name}`), () => {
      c.edit((d) => {
        Object.assign(d, migrateBeauty(d));
        d.background = { kind, color, endColor, angle: 125 };
        d.enabled = true;
      });
      c.rebuild();
    });
    node.textContent = "";
    node.title = node.ariaLabel = c.t(`beautify.bg.${name}`);
    node.classList.toggle("is-transparent", kind === "transparent");
    if (kind !== "transparent")
      node.style.background = `linear-gradient(125deg, ${color}, ${endColor})`;
    node.setAttribute(
      "aria-pressed",
      String(
        bg.kind === kind &&
          (kind === "transparent" || (bg.color === color && bg.endColor === endColor)),
      ),
    );
  }
  field(
    c.parent,
    c.t("beautify.customColor"),
    bg.color,
    (color) => {
      c.edit((d) => {
        Object.assign(d, migrateBeauty(d));
        d.background = { kind: "solid", color, endColor: color, angle: 125 };
        d.enabled = true;
      }, "background.color");
      for (const node of palette.children) node.setAttribute("aria-pressed", "false");
    },
    "color",
  );

  section("padding");
  const spacing = document.createElement("div");
  spacing.className = "beautify-spacing";
  spacing.setAttribute("role", "group");
  spacing.ariaLabel = c.t("beautify.padding");
  c.parent.append(spacing);
  for (const [name, amount] of [
    ["small", 80],
    ["medium", 120],
    ["large", 180],
  ] as const) {
    const value = (amount * c.document.referenceSize) / 1000;
    const node = button(spacing, c.t(`beautify.size.${name}`), () => {
      c.edit((d) => {
        d.frame.padding = [value, value, value, value];
        d.enabled = true;
      });
      c.rebuild();
    });
    node.setAttribute(
      "aria-pressed",
      String(c.document.frame.padding.every((n) => Math.abs(n - value) < 0.01)),
    );
  }
}

import { paragraphText } from "../../ocr/layout";
import {
  editBlock,
  selectedState,
  toggleUnit,
  unitsFor,
  type OcrSession,
  type OcrUnit,
} from "../../ocr/selection";

export function createOcrResultList(options: {
  root: HTMLElement;
  translate: (key: string, params?: Record<string, string | number>) => string;
  changed: () => void;
  hover: (unit: OcrUnit | null) => void;
  locate: (unit: OcrUnit) => void;
}) {
  const t = options.translate;
  let session: OcrSession | undefined;
  let byLine = false;
  let editing: string | null = null;
  let hovered: OcrUnit | null = null;
  const rows = new Map<string, { root: HTMLElement; check: HTMLInputElement; unit: OcrUnit }>();
  const button = (key: string, action: () => void) => {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = t(key);
    node.addEventListener("click", action);
    return node;
  };
  const update = () => {
    if (!session) return;
    for (const { root, check, unit } of rows.values()) {
      const state = selectedState(session, unit);
      check.checked = state === "all";
      check.indeterminate = state === "some";
      root.classList.toggle("selected", state !== "none");
      root.classList.toggle(
        "hovered",
        !!hovered &&
          hovered.block.id === unit.block.id &&
          (!byLine || hovered.lines.some((line) => unit.lines.includes(line))),
      );
    }
  };
  const focusEdit = (blockId: string) =>
    queueMicrotask(() => {
      const row = [...rows.values()].find((row) => row.unit.block.id === blockId);
      row?.root.querySelector<HTMLButtonElement>(".ocr-row-edit")?.focus({ preventScroll: true });
    });
  const render = () => {
    options.root.replaceChildren();
    rows.clear();
    if (!session) return;
    const current = session;
    for (const [index, unit] of unitsFor(current, byLine).entries()) {
      const row = document.createElement("section");
      row.className = "ocr-result-row";
      row.dataset.unit = unit.id;
      const toolbar = document.createElement("div");
      toolbar.className = "ocr-row-tools";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.setAttribute("aria-label", t("ocr.result.selectBlock", { n: index + 1 }));
      check.addEventListener("change", () => {
        toggleUnit(current, unit);
        options.changed();
      });
      const number = document.createElement("span");
      number.className = "ocr-row-number";
      number.textContent = String(index + 1).padStart(2, "0");
      toolbar.append(check, number);
      const edited = current.edits.has(unit.block.id);
      if (edited) {
        const badge = document.createElement("span");
        badge.textContent = t("ocr.result.edited");
        toolbar.append(badge);
      }
      const modify = button("ocr.result.edit", () => {
        editing = unit.id;
        render();
      });
      modify.className = "ocr-row-edit";
      toolbar.append(modify);
      row.append(toolbar);
      if (editing === unit.id) {
        const input = document.createElement("textarea");
        input.className = "ocr-row-input";
        input.spellcheck = false;
        input.setAttribute("aria-label", t("ocr.result.editBlock", { n: index + 1 }));
        input.value = current.edits.get(unit.block.id) ?? unit.block.original;
        const actions = document.createElement("div");
        actions.className = "ocr-edit-actions";
        actions.append(
          button("ocr.result.save", () => {
            editBlock(current, unit.block, input.value);
            editing = null;
            render();
            focusEdit(unit.block.id);
            options.changed();
          }),
          button("ocr.result.cancel", () => {
            editing = null;
            render();
            focusEdit(unit.block.id);
          }),
        );
        if (edited)
          actions.append(
            button("ocr.result.restore", () => {
              editBlock(current, unit.block, null);
              editing = null;
              render();
              focusEdit(unit.block.id);
              options.changed();
            }),
          );
        row.append(input, actions);
        queueMicrotask(() => {
          if (input.isConnected) input.focus();
        });
      } else {
        const text = document.createElement("p");
        text.className = "ocr-row-text";
        text.textContent =
          current.edits.get(unit.block.id) ??
          (unit.lines.length
            ? paragraphText(unit.lines.map((line) => line.text))
            : unit.block.original);
        text.addEventListener("click", () => {
          if (window.getSelection()?.toString()) return;
          options.locate(unit);
        });
        row.append(text);
      }
      row.addEventListener("pointerenter", () => options.hover(unit));
      row.addEventListener("pointerleave", () => options.hover(null));
      rows.set(unit.id, { root: row, check, unit });
      options.root.append(row);
    }
    update();
  };
  return {
    show(next: OcrSession | undefined, lines: boolean) {
      session = next;
      byLine = lines;
      editing = null;
      hovered = null;
      render();
    },
    refresh: render,
    update,
    hover(unit: OcrUnit | null) {
      hovered = unit;
      update();
    },
    locate(unit: OcrUnit) {
      const target =
        rows.get(unit.id) ?? [...rows.values()].find((row) => row.unit.block.id === unit.block.id);
      target?.root.scrollIntoView({ block: "nearest" });
    },
    cancelEdit() {
      if (!editing) return false;
      const blockId = rows.get(editing)?.unit.block.id;
      editing = null;
      render();
      if (blockId) focusEdit(blockId);
      return true;
    },
  };
}

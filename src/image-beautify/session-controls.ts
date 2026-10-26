import { button, type Translate } from "./controls";
import { bindHoldComparison } from "./hold-comparison";

export function createBeautySessionControls(options: {
  parent: HTMLElement;
  t: Translate;
  canCompare: () => boolean;
  changed: () => boolean;
  revert: () => void;
  complete: () => void;
  compare: (active: boolean) => void;
}) {
  const element = document.createElement("div");
  element.className = "beautify-session-controls";
  const compare = button(element, "", () => {});
  compare.classList.add("beautify-compare");
  const row = document.createElement("div");
  row.className = "beautify-session-actions";
  element.append(row);
  const revert = button(row, "", () => {
    hold.stop();
    options.revert();
    sync();
  });
  const complete = button(row, "", options.complete);
  complete.classList.add("beautify-complete");
  const hold = bindHoldComparison({
    button: compare,
    canStart: options.canCompare,
    onChange: (active) => {
      compare.textContent = options.t(
        active ? "beautify.comparingBefore" : "beautify.compareBefore",
      );
      options.compare(active);
    },
  });
  options.parent.append(element);
  function sync() {
    revert.disabled = !options.changed();
    compare.disabled = !options.canCompare();
    if (compare.disabled) hold.stop();
  }
  function translate() {
    compare.textContent = options.t(
      hold.isActive() ? "beautify.comparingBefore" : "beautify.compareBefore",
    );
    revert.textContent = options.t("beautify.revertRound");
    complete.textContent = options.t("beautify.completeRound");
    sync();
  }
  translate();
  return { element, sync, stopCompare: hold.stop, refreshTranslations: translate };
}

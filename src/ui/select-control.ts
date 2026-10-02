let nextSelectId = 0;
let closeActiveSelect: (() => void) | undefined;

/** 原 <select> 保留隐藏的原位，仍负责 value/change 契约；旁边渲染主题化的 listbox。 */
export function createSelectControl(select: HTMLSelectElement) {
  const wrapper = document.createElement("span");
  wrapper.className = "select-control";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "select-trigger";
  trigger.id = `${select.id || `select-${++nextSelectId}`}-trigger`;
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const text = document.createElement("span");
  text.className = "select-value";
  const arrow = document.createElement("span");
  arrow.className = "select-chevron";
  arrow.setAttribute("aria-hidden", "true");
  trigger.append(text, arrow);
  select.before(wrapper);
  wrapper.append(select, trigger);
  select.hidden = true;

  const menu = document.createElement("div");
  menu.className = "select-menu";
  menu.id = `${trigger.id}-list`;
  menu.setAttribute("role", "listbox");
  trigger.setAttribute("aria-controls", menu.id);
  let opened = false;
  let activeIndex = -1;
  let search = "";
  let lastSearchAt = 0;
  let items: HTMLElement[] = [];

  const available = () =>
    Array.from(select.options)
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.hidden && !option.disabled);

  const highlight = (index: number, scroll = true) => {
    activeIndex = index;
    items.forEach((item) => {
      item.classList.toggle("active", Number(item.dataset.index) === index);
    });
    const item = items.find((item) => Number(item.dataset.index) === index);
    if (item) {
      trigger.setAttribute("aria-activedescendant", item.id);
      if (scroll) item.scrollIntoView({ block: "nearest" });
    }
  };

  const close = () => {
    if (!opened) return;
    opened = false;
    menu.remove();
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    if (closeActiveSelect === close) closeActiveSelect = undefined;
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("wheel", onOutsidePointer, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("blur", close);
  };

  const refresh = () => {
    text.textContent = select.selectedOptions[0]?.textContent ?? "";
    trigger.disabled = select.disabled;
    trigger.title = select.title;
    const label =
      select.getAttribute("aria-label") ||
      Array.from(select.labels ?? [])
        .map((label) => label.textContent)
        .join(" ")
        .trim() ||
      select.title ||
      text.textContent;
    trigger.setAttribute("aria-label", label);
    menu.setAttribute("aria-label", label);
    close();
  };

  const choose = (index: number) => {
    const option = select.options[index];
    if (!option || option.disabled || option.hidden) return;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    close();
    refresh();
    trigger.focus({ preventScroll: true });
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  function onOutsidePointer(event: MouseEvent) {
    if (
      event.target instanceof Node &&
      !wrapper.contains(event.target) &&
      !menu.contains(event.target)
    ) {
      close();
    }
  }

  function onScroll(event: Event) {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    positionMenu();
  }

  function positionMenu() {
    const rect = trigger.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > window.innerHeight) {
      close();
      return;
    }
    menu.style.minWidth = `${Math.min(rect.width, window.innerWidth - 24)}px`;
    menu.style.maxHeight = "280px";
    const below = window.innerHeight - rect.bottom - 18;
    const above = rect.top - 18;
    const placeAbove = menu.offsetHeight > below && above > below;
    menu.style.maxHeight = `${Math.max(32, Math.min(280, placeAbove ? above : below))}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12))}px`;
    menu.style.top = `${placeAbove ? rect.top - menu.offsetHeight - 6 : rect.bottom + 6}px`;
  }

  const open = () => {
    if (select.disabled || !available().length) return;
    closeActiveSelect?.();
    refresh();
    menu.replaceChildren();
    items = [];
    Array.from(select.options).forEach((option, index) => {
      if (option.hidden) return;
      const item = document.createElement("div");
      item.className = "select-option";
      item.id = `${menu.id}-${index}`;
      item.dataset.index = String(index);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === select.selectedIndex));
      item.setAttribute("aria-disabled", String(option.disabled));
      item.classList.toggle("selected", index === select.selectedIndex);
      const label = document.createElement("span");
      label.textContent = option.textContent;
      const check = document.createElement("span");
      check.className = "select-check";
      check.textContent = "✓";
      check.setAttribute("aria-hidden", "true");
      item.append(label, check);
      item.addEventListener("pointermove", () => {
        if (!option.disabled) highlight(index, false);
      });
      item.addEventListener("click", () => choose(index));
      menu.append(item);
      items.push(item);
    });
    document.body.append(menu);
    opened = true;
    closeActiveSelect = close;
    positionMenu();
    if (!opened) return;
    search = "";
    trigger.setAttribute("aria-expanded", "true");
    highlight(
      available().some(({ index }) => index === select.selectedIndex)
        ? select.selectedIndex
        : available()[0].index,
    );
    document.addEventListener("pointerdown", onOutsidePointer, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("wheel", onOutsidePointer, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
  };

  trigger.addEventListener("click", () => (opened ? close() : open()));
  trigger.addEventListener("blur", close);
  menu.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      close();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      if (!opened) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!opened) {
        open();
        if (event.key !== "Home" && event.key !== "End") return;
      } else if (event.key === "Enter" || event.key === " ") {
        choose(activeIndex);
        return;
      }
      const choices = available();
      const index = choices.findIndex((choice) => choice.index === activeIndex);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? choices.length - 1
            : Math.max(0, Math.min(choices.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      if (choices[next]) highlight(choices[next].index);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!opened) open();
      const now = performance.now();
      search = now - lastSearchAt > 750 ? event.key : search + event.key;
      lastSearchAt = now;
      const choice = available().find(({ option }) =>
        option.textContent?.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()),
      );
      if (choice) highlight(choice.index);
    }
  });
  select.addEventListener("change", refresh);
  const observer = new MutationObserver(refresh);
  observer.observe(select, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  for (const label of Array.from(select.labels ?? [])) {
    label.addEventListener("click", (event) => {
      event.preventDefault();
      trigger.focus();
    });
  }
  refresh();
  return { refresh, close };
}

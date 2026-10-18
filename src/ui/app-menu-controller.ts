interface MenuState {
  edit: boolean;
  screenshotHotkey: string;
  scrollHotkey: string;
}

export type AppMenuAction =
  | "open-image"
  | "screenshot"
  | "scroll-screenshot"
  | "capture-settings"
  | "shortcuts"
  | "update";

interface MenuItem {
  key: string;
  action?: AppMenuAction;
  existing?: string;
  shortcut?: string;
  enabled?: (state: MenuState) => boolean;
}
type MenuEntry = MenuItem | "separator";
interface AppMenuOptions {
  toolbar: HTMLElement;
  translate: (key: string) => string;
  getState: () => MenuState;
  run: (action: AppMenuAction) => void | Promise<void>;
  onError: (error: unknown) => void;
}

const browsing = (state: MenuState) => !state.edit;
const MENUS: { key: string; items: MenuEntry[] }[] = [
  {
    key: "menu.file",
    items: [
      { key: "menu.openImage", action: "open-image", shortcut: "Ctrl+Shift+O", enabled: browsing },
      { key: "toolbar.open", existing: "btn-open", shortcut: "Ctrl+O", enabled: browsing },
      "separator",
      { key: "toolbar.settings", existing: "btn-settings", enabled: browsing },
    ],
  },
  {
    key: "menu.capture",
    items: [
      { key: "pet.menu.screenshot", action: "screenshot" },
      { key: "pet.menu.scrollScreenshot", action: "scroll-screenshot" },
      "separator",
      { key: "menu.captureSettings", action: "capture-settings", enabled: browsing },
    ],
  },
  {
    key: "menu.help",
    items: [
      { key: "menu.shortcuts", action: "shortcuts", shortcut: "F1" },
      { key: "settings.checkUpdate", action: "update", enabled: browsing },
      "separator",
      { key: "menu.about", existing: "btn-about", enabled: browsing },
    ],
  },
];

/** 三组简洁的应用菜单；图片操作由右键、编辑工具栏和网格控件承载。 */
export function createAppMenuController(options: AppMenuOptions) {
  const bindings: {
    item: MenuItem;
    node: HTMLButtonElement;
    label: HTMLElement;
    shortcut?: HTMLElement;
  }[] = [];
  const roots: HTMLDetailsElement[] = [];
  const existing = new Map<string, HTMLButtonElement>();
  for (const id of ["btn-open", "btn-settings", "btn-about"]) {
    const node = document.getElementById(id);
    if (node instanceof HTMLButtonElement) existing.set(id, node);
  }
  options.toolbar.replaceChildren();
  const close = () => {
    for (const root of roots) root.open = false;
  };
  const refresh = () => {
    const state = options.getState();
    for (const { item, node, label, shortcut } of bindings) {
      label.textContent = options.translate(item.key);
      node.disabled = item.enabled ? !item.enabled(state) : false;
      if (shortcut)
        shortcut.textContent =
          item.shortcut ??
          (item.action === "screenshot" ? state.screenshotHotkey : state.scrollHotkey);
    }
  };
  for (const menu of MENUS) {
    const details = document.createElement("details");
    details.className = "app-menu";
    const summary = document.createElement("summary");
    summary.dataset.i18n = menu.key;
    summary.textContent = options.translate(menu.key);
    const popup = document.createElement("div");
    popup.className = "app-menu-popover";
    popup.setAttribute("role", "menu");
    details.append(summary, popup);
    for (const item of menu.items) {
      if (item === "separator") {
        const separator = document.createElement("hr");
        separator.setAttribute("role", "separator");
        popup.append(separator);
        continue;
      }
      const node =
        (item.existing && existing.get(item.existing)) || document.createElement("button");
      node.type = "button";
      node.setAttribute("role", "menuitem");
      node.removeAttribute("data-i18n");
      node.replaceChildren();
      const label = document.createElement("span");
      label.dataset.i18n = item.key;
      node.append(label);
      let shortcut: HTMLElement | undefined;
      if (item.shortcut || item.action === "screenshot" || item.action === "scroll-screenshot") {
        shortcut = document.createElement("kbd");
        node.append(shortcut);
      }
      node.addEventListener("click", () => {
        close();
        if (item.action) Promise.resolve(options.run(item.action)).catch(options.onError);
      });
      bindings.push({ item, node, label, shortcut });
      popup.append(node);
    }
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      for (const root of roots) if (root !== details) root.open = false;
      refresh();
      popup.style.left = "0px";
      const edge =
        document.getElementById("app")?.getBoundingClientRect().right ?? window.innerWidth;
      const overflow = popup.getBoundingClientRect().right - edge + 6;
      if (overflow > 0) popup.style.left = `${-overflow}px`;
    });
    details.addEventListener("pointerenter", () => {
      if (roots.some((root) => root.open)) details.open = true;
    });
    roots.push(details);
    options.toolbar.append(details);
  }
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !options.toolbar.contains(event.target)) close();
  });
  options.toolbar.addEventListener("keydown", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const root = event.target.closest<HTMLDetailsElement>(".app-menu");
    if (!root) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      root.querySelector("summary")?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    refresh();
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const next =
        roots[
          (roots.indexOf(root) + (event.key === "ArrowRight" ? 1 : roots.length - 1)) % roots.length
        ];
      root.open = false;
      next.open = true;
      next.querySelector("summary")?.focus();
      return;
    }
    root.open = true;
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const index = items.indexOf(event.target as HTMLButtonElement);
    const nextIndex =
      index < 0
        ? event.key === "ArrowDown"
          ? 0
          : items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items[nextIndex]?.focus();
  });
  refresh();
  return { refresh, close };
}

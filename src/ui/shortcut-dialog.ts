import { uiIcon } from "./icons";

interface ShortcutDialogOptions {
  translate: (key: string) => string;
  getHotkeys: () => { screenshot: string; scroll: string };
  onOpen?: () => void;
}
interface ShortcutGroup {
  key: string;
  icon: Parameters<typeof uiIcon>[0];
  rows: [string, string][];
}

/** 应用内双栏速查；F1 属于当前窗口，模态层隔离底层编辑快捷键。 */
export function createShortcutDialog(options: ShortcutDialogOptions) {
  const dialog = document.createElement("dialog");
  dialog.className = "app-shortcuts-dialog floating-surface";
  const header = document.createElement("header");
  header.className = "app-shortcuts-header floating-header";
  const icon = document.createElement("span");
  icon.className = "app-shortcuts-symbol floating-symbol";
  icon.innerHTML = uiIcon("keyboard");
  const heading = document.createElement("div");
  heading.className = "floating-heading";
  const title = document.createElement("h2");
  title.id = "app-shortcuts-title";
  title.className = "floating-title";
  const hint = document.createElement("p");
  hint.className = "app-shortcuts-hint floating-hint";
  heading.append(title, hint);
  dialog.setAttribute("aria-labelledby", title.id);
  const closeIcon = document.createElement("button");
  closeIcon.type = "button";
  closeIcon.className = "app-shortcuts-close floating-close";
  closeIcon.innerHTML = uiIcon("close");
  closeIcon.addEventListener("click", () => dialog.close());
  header.append(icon, heading, closeIcon);
  const body = document.createElement("div");
  body.className = "app-shortcuts-body floating-body";
  const footer = document.createElement("footer");
  footer.className = "app-shortcuts-footer floating-actions floating-footer";
  const note = document.createElement("span");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "floating-action";
  close.addEventListener("click", () => dialog.close());
  footer.append(note, close);
  dialog.append(header, body, footer);
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  document.body.append(dialog);

  const open = () => {
    if (dialog.open) return;
    options.onOpen?.();
    const hotkeys = options.getHotkeys();
    title.textContent = options.translate("menu.shortcuts");
    hint.textContent = options.translate("shortcuts.hint");
    closeIcon.ariaLabel = options.translate("settings.close");
    close.textContent = options.translate("settings.close");
    note.textContent = options.translate("shortcuts.captureHint");
    body.replaceChildren();
    const columns: ShortcutGroup[][] = [
      [
        {
          key: "shortcuts.common",
          icon: "folder",
          rows: [
            ["toolbar.open", "Ctrl+O"],
            ["menu.openImage", "Ctrl+Shift+O"],
            ["menu.shortcuts", "F1"],
          ],
        },
        {
          key: "menu.capture",
          icon: "scan",
          rows: [
            ["pet.menu.screenshot", hotkeys.screenshot],
            ["pet.menu.scrollScreenshot", hotkeys.scroll],
          ],
        },
      ],
      [
        {
          key: "shortcuts.view",
          icon: "image",
          rows: [
            ["menu.fit", "0"],
            ["menu.actual", "1"],
            ["menu.rotate", "R"],
            ["menu.navigateImages", "← / →"],
            ["menu.switchView", "Tab"],
          ],
        },
        {
          key: "shortcuts.edit",
          icon: "pencil",
          rows: [
            ["toolbar.enterEdit", "Ctrl+E"],
            ["editor.undo", "Ctrl+Z"],
            ["editor.redo", "Ctrl+Y"],
          ],
        },
      ],
    ];
    for (const groups of columns) {
      const column = document.createElement("div");
      column.className = "app-shortcuts-column";
      for (const group of groups) {
        const section = document.createElement("section");
        const caption = document.createElement("h3");
        caption.innerHTML = uiIcon(group.icon);
        caption.append(document.createTextNode(options.translate(group.key)));
        const list = document.createElement("dl");
        for (const [key, shortcut] of group.rows) {
          const name = document.createElement("dt");
          name.textContent = options.translate(key);
          const value = document.createElement("dd");
          value.ariaLabel = shortcut;
          for (const part of shortcut.split(/([+/])/)) {
            const token = part.trim();
            if (!token) continue;
            const separator = token === "+" || token === "/";
            const keycap = document.createElement(separator ? "span" : "kbd");
            keycap.textContent = token;
            if (separator) keycap.ariaHidden = "true";
            value.append(keycap);
          }
          list.append(name, value);
        }
        section.append(caption, list);
        column.append(section);
      }
      body.append(column);
    }
    dialog.showModal();
    closeIcon.focus();
  };
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !== "F1" ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey ||
        event.isComposing
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) open();
    },
    { capture: true },
  );
  return { open };
}

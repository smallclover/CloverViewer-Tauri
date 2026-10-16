/** F5/Ctrl+R 只刷新目录，编辑或弹层期间也阻止 WebView 整页重载。 */
export function bindDirectoryRefreshShortcut(options: {
  isBlocked: () => boolean;
  refresh: () => Promise<unknown>;
}) {
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !== "F5" &&
        !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat && !options.isBlocked()) void options.refresh();
    },
    true,
  );
}

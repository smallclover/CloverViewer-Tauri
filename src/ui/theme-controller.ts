import type { AppConfig } from "../api";

/** 主窗口和截图窗口共用的主题偏好；system 在窗口存活期间实时更新。 */
export function createThemeController() {
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference: AppConfig["theme"] = "system";
  const render = () => {
    document.documentElement.dataset.theme =
      preference === "dark" || (preference === "system" && system.matches) ? "dark" : "light";
  };
  const change = () => {
    if (preference === "system") render();
  };
  system.addEventListener("change", change);
  return {
    set: (theme: AppConfig["theme"]) => {
      preference = theme;
      render();
    },
    dispose: () => system.removeEventListener("change", change),
  };
}

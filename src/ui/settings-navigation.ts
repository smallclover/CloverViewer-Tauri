import { playEnterAnimation } from "./presentation";

interface SettingsNavigationOptions {
  search: HTMLInputElement;
  tabs: HTMLButtonElement[];
  navGroups: HTMLElement[];
  groups: HTMLElement[];
  empty: HTMLElement;
  title: HTMLElement;
  description: HTMLElement;
  translate: (key: string) => string;
  refreshControls: () => void;
}

/** 分类名命中时显示整个分类，分组标题命中时显示整组，否则只显示匹配行。 */
export function createSettingsNavigation(options: SettingsNavigationOptions) {
  const { search, tabs, navGroups, groups } = options;
  const tabOf = (button: HTMLButtonElement) => button.dataset.settingsTab ?? "general";
  let activeTab = "general";
  const render = (animate = false) => {
    const query = search.value.trim().toLowerCase();
    const matches = (text: string | null | undefined) => (text ?? "").toLowerCase().includes(query);
    const matchingTabs = new Set(tabs.filter((tab) => matches(tab.textContent)).map(tabOf));
    const groupHits = new Map<HTMLElement, number>();
    const tabHits = new Map<string, number>();
    for (const group of groups) {
      const tab = group.dataset.settingsSection ?? "general";
      const wholeGroup =
        !query ||
        matchingTabs.has(tab) ||
        matches(group.querySelector(".settings-group-title")?.textContent);
      let hits = 0;
      for (const row of group.querySelectorAll<HTMLElement>(".setting-row")) {
        const hit = wholeGroup || matches(row.textContent);
        row.hidden = !hit;
        if (hit) hits++;
      }
      groupHits.set(group, hits);
      tabHits.set(tab, (tabHits.get(tab) ?? 0) + hits);
    }
    for (const tab of tabs) tab.hidden = (tabHits.get(tabOf(tab)) ?? 0) === 0;
    for (const group of navGroups) {
      group.hidden = !Array.from(
        group.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"),
      ).some((tab) => !tab.hidden);
    }
    options.empty.hidden = tabs.some((tab) => !tab.hidden);
    const activeButton = tabs.find((tab) => tabOf(tab) === activeTab);
    if (!activeButton || activeButton.hidden) {
      const fallback = tabs.find((tab) => !tab.hidden);
      if (fallback) activeTab = tabOf(fallback);
    }
    for (const tab of tabs) tab.classList.toggle("active", tabOf(tab) === activeTab);
    for (const group of groups) {
      const visible =
        group.dataset.settingsSection === activeTab && (groupHits.get(group) ?? 0) > 0;
      group.hidden = !visible;
      if (visible && animate) playEnterAnimation(group, "tab-enter");
    }
    options.title.textContent = options.translate(`settings.tab.${activeTab}`);
    options.description.textContent = options.translate(`settings.tab.${activeTab}.desc`);
    options.refreshControls();
  };
  const selectTab = (tab: string) => {
    activeTab = tab;
    render(true);
  };
  for (const tab of tabs) tab.addEventListener("click", () => selectTab(tabOf(tab)));
  search.addEventListener("input", () => render());
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !search.value) return;
    event.stopPropagation();
    search.value = "";
    render();
  });
  return { render, selectTab };
}

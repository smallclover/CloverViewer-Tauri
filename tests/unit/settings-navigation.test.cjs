const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const loadTs = require("./helpers/load-ts.cjs");

function fixture() {
  const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
  const text = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const node = (textContent = "") => {
    const handlers = new Map(), classes = new Set();
    return { textContent, dataset: {}, hidden: false,
      classList: { toggle: (key, active) => active ? classes.add(key) : classes.delete(key), contains: key => classes.has(key) },
      addEventListener: (name, action) => handlers.set(name, action),
      fire: (name, event) => handlers.get(name)?.(event),
    };
  };
  const tabs = [...html.matchAll(/<button[^>]*data-settings-tab="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map(([, id, body]) => ({ ...node(text(body)), dataset: { settingsTab: id } }));
  const groups = [...html.matchAll(/<section class="settings-group" data-settings-section="([^"]+)">([\s\S]*?)<\/section>/g)]
    .map(([, id, body]) => {
      const title = node(text(body.match(/class="settings-group-title"[^>]*>(.*?)<\/span>/)[1]));
      const rows = body.split(/<div class="setting-row(?: [^"]*)?">/).slice(1).map(row => node(text(row)));
      return { ...node(), dataset: { settingsSection: id }, title, rows,
        querySelector: () => title, querySelectorAll: () => rows };
    });
  const navGroups = [...html.matchAll(/<div class="settings-nav-group"[^>]*>([\s\S]*?)<\/div>/g)]
    .map(([, body]) => ({ ...node(), querySelectorAll: () => tabs.filter(tab => body.includes(`data-settings-tab="${tab.dataset.settingsTab}"`)) }));
  const search = { ...node(), value: "" }, empty = node(), title = node();
  const { createSettingsNavigation } = loadTs("ui/settings-navigation.ts", {
    "./presentation": { playEnterAnimation() {} },
  });
  const navigation = createSettingsNavigation({ search, tabs, navGroups, groups, empty, title,
    description: node(), translate: key => key, refreshControls() {} });
  const find = query => { search.value = query; search.fire("input"); };
  navigation.render();
  return { ...navigation, tabs, groups, navGroups, search, empty, title, find,
    visible: () => groups.filter(group => !group.hidden),
  };
}

test("each settings category has content and relocated controls remain searchable", () => {
  const f = fixture();
  assert.deepEqual(f.tabs.map(tab => tab.dataset.settingsTab), ["general", "appearance", "view", "capture", "ocr", "hotkeys", "sharing", "cache"]);
  for (const tab of f.tabs) {
    f.selectTab(tab.dataset.settingsTab);
    assert.ok(f.visible().length > 0);
  }
  for (const [query, category] of [["语言", "general"], ["桌宠缩放", "appearance"], ["默认有效期", "sharing"], ["软件更新", "cache"], ["高精度", "ocr"]]) {
    f.find(query);
    assert.equal(f.visible()[0].dataset.settingsSection, category);
  }
});

test("category searches display all groups instead of an empty page", () => {
  const f = fixture();
  for (const [query, category] of [["常规", "general"], ["外观与桌宠", "appearance"], ["更新与缓存", "cache"]]) {
    f.find(query);
    assert.ok(f.visible().length > 0);
    assert.equal(f.visible().length, f.groups.filter(group => group.dataset.settingsSection === category).length);
    assert.ok(f.visible().every(group => group.rows.every(row => !row.hidden)));
    assert.equal(f.title.textContent, `settings.tab.${category}`);
  }
});

test("group titles reveal the entire group while row searches stay focused", () => {
  const f = fixture();
  f.find("界面外观");
  assert.equal(f.visible().length, 1);
  assert.ok(f.visible()[0].rows.every(row => !row.hidden));
  f.find("开机自启");
  assert.equal(f.visible().length, 1);
  assert.equal(f.visible()[0].rows.filter(row => !row.hidden).length, 1);
});

test("no-result searches hide empty navigation groups and Escape restores all categories", () => {
  const f = fixture();
  f.find("no-such-setting");
  assert.equal(f.empty.hidden, false);
  assert.equal(f.visible().length, 0);
  assert.ok(f.navGroups.every(group => group.hidden));
  let stopped = false;
  f.search.fire("keydown", { key: "Escape", stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(f.search.value, "");
  assert.equal(f.empty.hidden, true);
  assert.ok(f.tabs.every(tab => !tab.hidden));
  f.selectTab("capture");
  assert.equal(f.title.textContent, "settings.tab.capture");
});

test("matching follows translated labels and ignores case and outer whitespace", () => {
  const f = fixture();
  f.tabs.find(tab => tab.dataset.settingsTab === "appearance").textContent = "Appearance & pet";
  f.find(" APPEARANCE & PET ");
  assert.equal(f.visible().length, 3);
  assert.ok(f.visible().every(group => group.rows.every(row => !row.hidden)));
});

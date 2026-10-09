import { translations } from "./content.js";

const selector = document.querySelector("#language");
const supported = new Set(Object.keys(translations));

function setLanguage(language) {
  const copy = translations[language];
  document.documentElement.lang = language;
  document.title = copy.pageTitle;
  document.querySelector('meta[name="description"]').content = copy.description;
  for (const node of document.querySelectorAll("[data-copy]")) {
    node.textContent = copy[node.dataset.copy];
  }
  for (const node of document.querySelectorAll("[data-copy-alt]")) {
    node.alt = copy[node.dataset.copyAlt];
  }
  for (const node of document.querySelectorAll("[data-copy-label]")) {
    node.setAttribute("aria-label", copy[node.dataset.copyLabel]);
  }
  // Link to the README matching the selected language.
  document.querySelector("#readme-link").href =
    "https://github.com/smallclover/CloverViewer-Tauri/blob/main/" +
    { "zh-CN": "README.md", en: "README.en.md", ja: "README.ja.md" }[language];
  selector.value = language;
}

const url = new URL(window.location.href);
const initial = url.searchParams.get("lang");
setLanguage(supported.has(initial) ? initial : "zh-CN");
selector.hidden = false;
selector.addEventListener("change", () => {
  if (!supported.has(selector.value)) return;
  setLanguage(selector.value);
  const next = new URL(window.location.href);
  if (selector.value === "zh-CN") next.searchParams.delete("lang");
  else next.searchParams.set("lang", selector.value);
  window.history.replaceState(null, "", next);
});

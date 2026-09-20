import { en, ja, zh } from "./locales";

// i18n runtime: language selection, interpolation, and DOM synchronization.
export type Lang = "Zh" | "En" | "Ja";
type Dict = Record<string, string>;

const DICTS: Record<Lang, Dict> = { Zh: zh, En: en, Ja: ja };

let currentLang: Lang = "Zh";

export function setLang(lang: Lang) {
  currentLang = DICTS[lang] ? lang : "Zh";
}

export function getLang(): Lang {
  return currentLang;
}

/** 取当前语言文案，支持 {name} 占位符插值 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[currentLang];
  let text = dict[key] ?? DICTS.Zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(String(v));
    }
  }
  return text;
}

/**
 * 扫描 root 下的 data-i18n* 属性并替换文案：
 *   data-i18n             → textContent
 *   data-i18n-title       → title
 *   data-i18n-placeholder → placeholder
 */
export function applyI18n(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    if (el.dataset.i18n) el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    if (el.dataset.i18nTitle) el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    if (el.dataset.i18nPlaceholder) el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

import { t } from "../i18n";
import { iconSvg, UI_ICON_PATHS } from "../ui/icons";

const ICONS: Record<string, string> = {
  ...UI_ICON_PATHS,
  width:
    '<path d="M4 6h16" stroke-width="1"/><path d="M4 12h16" stroke-width="3"/><path d="M4 19h16" stroke-width="5"/>',
  cancel: UI_ICON_PATHS.close,
  open:
    '<path d="M4 19V6a2 2 0 0 1 2-2h5l2 2h5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/>' +
    '<path d="m11 10 3 3-3 3M6 13h8"/>',
  share:
    '<circle cx="18" cy="5" r="2.5"/>' +
    '<circle cx="6" cy="12" r="2.5"/>' +
    '<circle cx="18" cy="19" r="2.5"/>' +
    '<path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/>',
  // OCR / 文字识别：扫描框（四角）+ 三行文字（lucide scan-text 风格），
  // 一眼即“扫描识别文字”，比原先的“方块+几条线”更贴切。
  ocr:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/>' +
    '<path d="M17 3h2a2 2 0 0 1 2 2v2"/>' +
    '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/>' +
    '<path d="M7 21H5a2 2 0 0 1-2-2v-2"/>' +
    '<path d="M7 8h8"/>' +
    '<path d="M7 12h10"/>' +
    '<path d="M7 16h6"/>',
  // 重新截图：刷新环箭头（lucide rotate-cw 风格），点它清空选区回到拉框
  reselect: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  // 滚动截图：一页纸 + 向下的续页箭头（“往下一直截”）
  scroll:
    '<rect x="6" y="3" width="12" height="16" rx="1.6"/>' +
    '<path d="M12 7v7"/>' +
    '<path d="M9.4 11.4 12 14l2.6-2.6"/>',
};

export function svgIcon(name: string): string {
  return iconSvg(ICONS[name] ?? "");
}

export function makeBtn(icon: string, titleKey: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.innerHTML = svgIcon(icon);
  b.title = t(titleKey);
  b.dataset.i18nTitle = titleKey;
  return b;
}

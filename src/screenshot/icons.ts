import { t } from "../i18n";

const ICONS: Record<string, string> = {
  rect: '<rect x="4" y="5" width="16" height="14" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  // 双向端帽（贴齐 egui paint_arrow_icon：line + end 两侧各一段短斜线）
  arrow: '<path d="M5 19 L19 5 M13 5 H19 V11"/>',
  // 正弦波笔触（贴齐 egui paint_pencil_icon：base_y + sin(t·π·2.5)·h·0.25）。
  // SVG 里用 3 段 Q/T 沿 x 等距升高抄此几何，比 lucide 钢笔更"画线"而
  // 不是"持笔"。
  pen: '<path d="M4 19 Q 6 7 8.5 13 T 12 12 T 15.5 13 T 20 5"/>',
  // 马赛克：对角填充（左上 + 右下 fill="currentColor" stroke="none"），
  // 另两角只描边（fill="none"），与原版 egui `paint_mosaic_icon` 的对角逻辑一致。
  mosaic:
    '<rect x="4" y="4" width="7" height="7" rx="1" fill="none"/>' +
    '<rect x="13" y="4" width="7" height="7" rx="1" fill="none"/>' +
    '<rect x="4" y="13" width="7" height="7" rx="1" fill="none"/>' +
    '<rect x="13" y="13" width="7" height="7" rx="1" fill="none"/>' +
    '<rect x="4" y="4" width="7" height="7" rx="1" fill="currentColor" stroke="none"/>' +
    '<rect x="13" y="13" width="7" height="7" rx="1" fill="currentColor" stroke="none"/>',
  // 仅 T（贴齐 egui `paint_text_icon`：顶横 + 中竖，无底横脚）
  text: '<path d="M5 5 V3 H19 V5 M12 3 V21"/>',
  cancel: '<path d="M6 6 L18 18 M18 6 L6 18"/>',
  // 双错位矩形 + 前层 fill="#fff"（白底覆盖，露出后层轮廓；工具栏白底背景下成立）
  copy:
    '<rect x="8" y="8" width="11" height="11" rx="1.5" fill="none"/>' +
    '<rect x="5" y="5" width="11" height="11" rx="1.5" fill="#ffffff" stroke="none"/>' +
    '<rect x="5" y="5" width="11" height="11" rx="1.5"/>',
  // 保存：向下箭落入开口托盘（lucide download 风格），一眼即“保存/落盘”
  save:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<path d="M7 10l5 5 5-5"/>' +
    '<path d="M12 15V3"/>',
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

function svgIcon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

export function makeBtn(icon: string, titleKey: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.innerHTML = svgIcon(icon);
  b.title = t(titleKey);
  b.dataset.i18nTitle = titleKey;
  return b;
}

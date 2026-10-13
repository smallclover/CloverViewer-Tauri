/** 查看器、图片编辑与截图共用的线框图标；颜色始终由当前主题决定。 */
export const UI_ICON_PATHS = {
  rect: '<rect x="4" y="5" width="16" height="14" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  arrow: '<path d="M5 19 19 5M13 5h6v6"/>',
  pen: '<path d="M4 19Q6 7 8.5 13T12 12t3.5 1T20 5"/>',
  mosaic:
    '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  text: '<path d="M5 5V3h14v2M12 3v18"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M16 8V5H5v11h3"/>',
  save: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
} as const;

export function iconSvg(path: string) {
  return `<svg class="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

export function uiIcon(name: keyof typeof UI_ICON_PATHS) {
  return iconSvg(UI_ICON_PATHS[name]);
}

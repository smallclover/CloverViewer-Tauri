const ICONS: Record<string, string> = {
  "editor.select": '<path d="m5 3 14 9-7 2-3 7Z"/>',
  "editor.crop": '<path d="M5 3v13a3 3 0 0 0 3 3h13"/><path d="M19 21V8a3 3 0 0 0-3-3H3"/>',
  "editor.rotate": '<path d="M21 4v6h-6"/><path d="M21 10a9 9 0 1 0-2.8 8"/>',
  "shot.rect": '<rect x="4" y="5" width="16" height="14" rx="2"/>',
  "shot.circle": '<circle cx="12" cy="12" r="7.5"/>',
  "shot.arrow": '<path d="M5 19 19 5M13 5h6v6"/>',
  "shot.pen": '<path d="M4 19Q6 7 8.5 13T12 12t3.5 1T20 5"/>',
  "shot.mosaic":
    '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  "shot.text": '<path d="M5 5V3h14v2M12 3v18"/>',
  "editor.undo": '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6"/>',
  "editor.redo": '<path d="m15 7 5 5-5 5"/><path d="M20 12H10a6 6 0 0 0-6 6"/>',
  "editor.saveAs":
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  "editor.overwrite": '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3M8 21v-7h8v7"/>',
  "editor.cancel": '<path d="m6 6 12 12M18 6 6 18"/>',
  "editor.saveOptions": '<path d="m7 10 5 5 5-5"/>',
};

export function editorIcon(key: string) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key] ?? ""}</svg>`;
}

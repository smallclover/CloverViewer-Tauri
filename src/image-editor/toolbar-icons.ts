import { iconSvg, UI_ICON_PATHS } from "../ui/icons";

const ICONS: Record<string, string> = {
  "editor.select": '<path d="m5 3 14 9-7 2-3 7Z"/>',
  "editor.crop": '<path d="M5 3v13a3 3 0 0 0 3 3h13"/><path d="M19 21V8a3 3 0 0 0-3-3H3"/>',
  "editor.rotate": '<path d="M21 4v6h-6"/><path d="M21 10a9 9 0 1 0-2.8 8"/>',
  "editor.applyCrop": '<path d="m5 12 4 4L19 6"/>',
  "editor.cancelCrop": UI_ICON_PATHS.close,
  "editor.deleteAnnotation": '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  "shot.rect": UI_ICON_PATHS.rect,
  "shot.circle": UI_ICON_PATHS.circle,
  "shot.arrow": UI_ICON_PATHS.arrow,
  "shot.pen": UI_ICON_PATHS.pen,
  "shot.mosaic": UI_ICON_PATHS.mosaic,
  "shot.text": UI_ICON_PATHS.text,
  "editor.undo": '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6"/>',
  "editor.redo": '<path d="m15 7 5 5-5 5"/><path d="M20 12H10a6 6 0 0 0-6 6"/>',
  "editor.reset": '<path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6"/>',
  "editor.saveAs": UI_ICON_PATHS.save,
  "editor.overwrite": '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3M8 21v-7h8v7"/>',
  "editor.cancel": UI_ICON_PATHS.close,
  "editor.saveOptions": '<path d="m7 10 5 5 5-5"/>',
};

export function editorIcon(key: string) {
  return iconSvg(ICONS[key] ?? "");
}

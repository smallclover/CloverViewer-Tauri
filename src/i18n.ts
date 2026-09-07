// ============================================================
// i18n —— 三语言文案（简体中文 / English / 日本語）
//
// 静态文案：在 HTML 元素上标记 data-i18n / data-i18n-title /
// data-i18n-placeholder，调用 applyI18n() 统一扫描替换。
// 动态文案：运行时调用 t("key", { ...vars }) 获取当前语言文本。
// 语言值 "Zh" | "En" | "Ja" 与后端 config.language 完全一致。
// ============================================================

export type Lang = "Zh" | "En" | "Ja";

type Dict = Record<string, string>;

const zh: Dict = {
  // 工具栏
  "toolbar.open": "打开文件夹",
  "toolbar.openTitle": "打开文件夹 (Ctrl+O)",
  "toolbar.rotate": "旋转 (R)",
  "toolbar.flipH": "水平翻转 (H)",
  "toolbar.flipV": "垂直翻转 (V)",
  "toolbar.props": "属性",
  "toolbar.propsTitle": "显示/隐藏属性栏",
  "toolbar.settings": "设置",
  "win.min": "最小化",
  "win.close": "关闭",
  // 空状态
  "empty.title": "尚未打开文件夹",
  "empty.hint": "点击「打开文件夹」或拖入图片 / Ctrl+O",
  // 属性栏
  "props.title": "属性",
  // 状态栏
  "status.ready": "就绪",
  "status.noImages": "（无图片）",
  "status.imageCount": "{count} 张图片",
  "nav.prev": "上一张",
  "nav.next": "下一张",
  // 视图切换
  "view.grid": "网格",
  "view.gridTitle": "网格视图",
  "view.single": "单图",
  "view.singleTitle": "单图视图",
  // 拖放
  "drop.open": "松开以打开",
  // 设置弹窗
  "settings.title": "设置",
  "settings.close": "关闭",
  "settings.language": "语言 / Language",
  "settings.language.zh": "简体中文",
  "settings.language.en": "English",
  "settings.language.ja": "日本語",
  "settings.theme": "主题",
  "settings.theme.system": "跟随系统",
  "settings.theme.dark": "深色",
  "settings.theme.light": "浅色",
  "settings.zoom": "缩放灵敏度",
  "settings.hotkey": "截图热键",
  "settings.colorHotkey": "取色热键",
  "settings.apply": "应用",
  "settings.magnifier": "截图放大镜",
  "settings.minimize": "关闭时最小化到托盘",
  "settings.autostart": "开机自启",
  // toast
  "toast.noImages": "该目录下没有图片",
  "toast.openFailed": "打开失败: {msg}",
  "toast.noImagesOpenFirst": "暂无图片，请先打开文件夹",
  "toast.copiedImage": "已复制图片",
  "toast.copyFailed": "复制失败: {msg}",
  "toast.copiedPath": "已复制路径",
  "toast.autostartOn": "已开启开机自启",
  "toast.autostartOff": "已关闭开机自启",
  "toast.autostartFailed": "设置开机自启失败: {msg}",
  "toast.hotkeyEmpty": "热键不能为空",
  "toast.hotkeySet": "截图热键已设为 {key}",
  "toast.hotkeyFailed": "设置热键失败: {msg}",
  "toast.colorHotkeySet": "取色热键已设为 {key}",
  "toast.saved": "已保存",
  "toast.saveFailed": "保存失败",
  // 属性面板字段
  "prop.filename": "文件名",
  "prop.path": "路径",
  "prop.dimensions": "尺寸",
  "prop.size": "大小",
  "prop.modified": "修改时间",
  "prop.format": "格式",
  "prop.datetime": "拍摄时间",
  "prop.camera": "相机",
  "prop.iso": "ISO",
  "prop.aperture": "光圈",
  "prop.shutter": "快门",
  "prop.focal": "焦距",
  "prop.lens": "镜头",
  // 右键菜单
  "ctx.view": "查看",
  "ctx.copyImage": "复制图片",
  "ctx.copyPath": "复制图片路径",
  // 截图标注器
  "shot.rect": "矩形",
  "shot.circle": "椭圆",
  "shot.arrow": "箭头",
  "shot.pen": "画笔",
  "shot.mosaic": "马赛克",
  "shot.text": "文字",
  "shot.color": "颜色",
  "shot.width": "线宽",
  "shot.cancel": "取消 (Esc)",
  "shot.reselect": "重新截图",
  "shot.copy": "复制到剪贴板 (Enter)",
  "shot.save": "保存到桌面",
  "shot.ocr": "文字识别 (OCR)",
  "shot.help":
    "拖动选择区域 · 选工具后标注\nEsc 取消 · Enter 复制 · Delete 删除选中\nCtrl+Z 撤销 · Ctrl+Y 重做",
  "shot.ocrTitle": "OCR 结果",
  "shot.copyAll": "复制全部文本",
  "shot.close": "关闭",
  "shot.copied": "已复制",
  "shot.copyColorHint": "按 {key} 复制颜色",
  "shot.ocrRecognizing": "正在识别…",
  "shot.ocrEmpty": "（未识别到文本）",
  "shot.ocrFailed": "识别失败：{msg}",
};

const en: Dict = {
  "toolbar.open": "Open Folder",
  "toolbar.openTitle": "Open Folder (Ctrl+O)",
  "toolbar.rotate": "Rotate (R)",
  "toolbar.flipH": "Flip Horizontal (H)",
  "toolbar.flipV": "Flip Vertical (V)",
  "toolbar.props": "Properties",
  "toolbar.propsTitle": "Show/Hide Properties",
  "toolbar.settings": "Settings",
  "win.min": "Minimize",
  "win.close": "Close",
  "empty.title": "No folder opened",
  "empty.hint": 'Click "Open Folder" or drop images / Ctrl+O',
  "props.title": "Properties",
  "status.ready": "Ready",
  "status.noImages": "(no images)",
  "status.imageCount": "{count} images",
  "nav.prev": "Previous",
  "nav.next": "Next",
  "view.grid": "Grid",
  "view.gridTitle": "Grid View",
  "view.single": "Single",
  "view.singleTitle": "Single View",
  "drop.open": "Release to open",
  "settings.title": "Settings",
  "settings.close": "Close",
  "settings.language": "Language",
  "settings.language.zh": "简体中文",
  "settings.language.en": "English",
  "settings.language.ja": "日本語",
  "settings.theme": "Theme",
  "settings.theme.system": "System",
  "settings.theme.dark": "Dark",
  "settings.theme.light": "Light",
  "settings.zoom": "Zoom Sensitivity",
  "settings.hotkey": "Screenshot Hotkey",
  "settings.colorHotkey": "Color Copy Hotkey",
  "settings.apply": "Apply",
  "settings.magnifier": "Screenshot Magnifier",
  "settings.minimize": "Minimize to tray on close",
  "settings.autostart": "Launch on startup",
  "toast.noImages": "No images in this folder",
  "toast.openFailed": "Open failed: {msg}",
  "toast.noImagesOpenFirst": "No images yet, open a folder first",
  "toast.copiedImage": "Image copied",
  "toast.copyFailed": "Copy failed: {msg}",
  "toast.copiedPath": "Path copied",
  "toast.autostartOn": "Launch on startup enabled",
  "toast.autostartOff": "Launch on startup disabled",
  "toast.autostartFailed": "Failed to set launch on startup: {msg}",
  "toast.hotkeyEmpty": "Hotkey cannot be empty",
  "toast.hotkeySet": "Screenshot hotkey set to {key}",
  "toast.hotkeyFailed": "Failed to set hotkey: {msg}",
  "toast.colorHotkeySet": "Color copy hotkey set to {key}",
  "toast.saved": "Saved",
  "toast.saveFailed": "Save failed",
  "prop.filename": "File Name",
  "prop.path": "Path",
  "prop.dimensions": "Dimensions",
  "prop.size": "Size",
  "prop.modified": "Modified",
  "prop.format": "Format",
  "prop.datetime": "Date Taken",
  "prop.camera": "Camera",
  "prop.iso": "ISO",
  "prop.aperture": "Aperture",
  "prop.shutter": "Shutter",
  "prop.focal": "Focal Length",
  "prop.lens": "Lens",
  "ctx.view": "View",
  "ctx.copyImage": "Copy Image",
  "ctx.copyPath": "Copy Image Path",
  "shot.rect": "Rectangle",
  "shot.circle": "Ellipse",
  "shot.arrow": "Arrow",
  "shot.pen": "Pen",
  "shot.mosaic": "Mosaic",
  "shot.text": "Text",
  "shot.color": "Color",
  "shot.width": "Width",
  "shot.cancel": "Cancel (Esc)",
  "shot.reselect": "Reselect",
  "shot.copy": "Copy to Clipboard (Enter)",
  "shot.save": "Save to Desktop",
  "shot.ocr": "OCR",
  "shot.help":
    "Drag to select area · pick a tool to annotate\nEsc Cancel · Enter Copy · Delete remove selection\nCtrl+Z Undo · Ctrl+Y Redo",
  "shot.ocrTitle": "OCR Result",
  "shot.copyAll": "Copy All Text",
  "shot.close": "Close",
  "shot.copied": "Copied",
  "shot.copyColorHint": "Press {key} to copy color",
  "shot.ocrRecognizing": "Recognizing…",
  "shot.ocrEmpty": "(no text detected)",
  "shot.ocrFailed": "OCR failed: {msg}",
};

const ja: Dict = {
  "toolbar.open": "フォルダを開く",
  "toolbar.openTitle": "フォルダを開く (Ctrl+O)",
  "toolbar.rotate": "回転 (R)",
  "toolbar.flipH": "左右反転 (H)",
  "toolbar.flipV": "上下反転 (V)",
  "toolbar.props": "プロパティ",
  "toolbar.propsTitle": "プロパティを表示/非表示",
  "toolbar.settings": "設定",
  "win.min": "最小化",
  "win.close": "閉じる",
  "empty.title": "フォルダが開かれていません",
  "empty.hint": "「フォルダを開く」をクリック、または画像をドロップ / Ctrl+O",
  "props.title": "プロパティ",
  "status.ready": "準備完了",
  "status.noImages": "（画像なし）",
  "status.imageCount": "{count} 枚の画像",
  "nav.prev": "前へ",
  "nav.next": "次へ",
  "view.grid": "グリッド",
  "view.gridTitle": "グリッド表示",
  "view.single": "単一",
  "view.singleTitle": "単一表示",
  "drop.open": "ドロップして開く",
  "settings.title": "設定",
  "settings.close": "閉じる",
  "settings.language": "言語 / Language",
  "settings.language.zh": "简体中文",
  "settings.language.en": "English",
  "settings.language.ja": "日本語",
  "settings.theme": "テーマ",
  "settings.theme.system": "システムに従う",
  "settings.theme.dark": "ダーク",
  "settings.theme.light": "ライト",
  "settings.zoom": "ズーム感度",
  "settings.hotkey": "スクリーンショットのホットキー",
  "settings.colorHotkey": "カラーコピーのホットキー",
  "settings.apply": "適用",
  "settings.magnifier": "スクリーンショット拡大鏡",
  "settings.minimize": "閉じたときにトレイに最小化",
  "settings.autostart": "起動時に自動起動",
  "toast.noImages": "このフォルダに画像がありません",
  "toast.openFailed": "開けませんでした: {msg}",
  "toast.noImagesOpenFirst": "画像がありません。先にフォルダを開いてください",
  "toast.copiedImage": "画像をコピーしました",
  "toast.copyFailed": "コピーに失敗しました: {msg}",
  "toast.copiedPath": "パスをコピーしました",
  "toast.autostartOn": "起動時の自動起動を有効にしました",
  "toast.autostartOff": "起動時の自動起動を無効にしました",
  "toast.autostartFailed": "自動起動の設定に失敗しました: {msg}",
  "toast.hotkeyEmpty": "ホットキーを入力してください",
  "toast.hotkeySet": "スクリーンショットのホットキーを {key} に設定しました",
  "toast.hotkeyFailed": "ホットキーの設定に失敗しました: {msg}",
  "toast.colorHotkeySet": "カラーコピーのホットキーを {key} に設定しました",
  "toast.saved": "保存しました",
  "toast.saveFailed": "保存に失敗しました",
  "prop.filename": "ファイル名",
  "prop.path": "パス",
  "prop.dimensions": "サイズ",
  "prop.size": "容量",
  "prop.modified": "更新日時",
  "prop.format": "形式",
  "prop.datetime": "撮影日時",
  "prop.camera": "カメラ",
  "prop.iso": "ISO",
  "prop.aperture": "絞り",
  "prop.shutter": "シャッター",
  "prop.focal": "焦点距離",
  "prop.lens": "レンズ",
  "ctx.view": "表示",
  "ctx.copyImage": "画像をコピー",
  "ctx.copyPath": "画像パスをコピー",
  "shot.rect": "矩形",
  "shot.circle": "楕円",
  "shot.arrow": "矢印",
  "shot.pen": "ペン",
  "shot.mosaic": "モザイク",
  "shot.text": "テキスト",
  "shot.color": "色",
  "shot.width": "線の太さ",
  "shot.cancel": "キャンセル (Esc)",
  "shot.reselect": "選択し直し",
  "shot.copy": "クリップボードにコピー (Enter)",
  "shot.save": "デスクトップに保存",
  "shot.ocr": "OCR（文字認識）",
  "shot.help":
    "ドラッグで領域選択 · ツールを選んで注釈\nEsc キャンセル · Enter コピー · Delete 選択を削除\nCtrl+Z 元に戻す · Ctrl+Y やり直す",
  "shot.ocrTitle": "OCR 結果",
  "shot.copyAll": "すべてのテキストをコピー",
  "shot.close": "閉じる",
  "shot.copied": "コピー済み",
  "shot.copyColorHint": "{key} で色をコピー",
  "shot.ocrRecognizing": "認識中…",
  "shot.ocrEmpty": "（テキストを検出できませんでした）",
  "shot.ocrFailed": "認識に失敗しました：{msg}",
};

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
  let text = dict[key] ?? zh[key] ?? key;
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
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  });
}

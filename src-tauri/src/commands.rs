//! Tauri 命令：前端可调用的后端接口

use crate::config::{Config, ConfigStore};
use crate::image_scan::{self, ImageEntry};
use base64::Engine;
use std::path::Path;
use tauri::State;

#[tauri::command]
pub fn get_config(store: State<'_, ConfigStore>) -> Config {
    (*store.snapshot()).clone()
}

#[tauri::command]
pub fn set_config(store: State<'_, ConfigStore>, config: Config) {
    // 窗口位置/大小由后端窗口事件维护，此处保留后端已知值，避免前端旧值覆盖
    let mut new_config = config;
    let current = store.snapshot();
    if new_config.window_pos.is_none() {
        new_config.window_pos = current.window_pos;
    }
    if new_config.window_size.is_none() {
        new_config.window_size = current.window_size;
    }
    store.replace(new_config.clone());
    crate::config::save_config(&new_config);
}

/// 设置开机自启（写/删 HKCU\...\Run 注册表）
#[tauri::command]
pub fn set_launch_on_startup(enabled: bool) -> Result<(), String> {
    crate::startup::set_launch_on_startup(enabled)
}

/// 重注册截图全局热键（注销旧键 → 注册新键 → 持久化）
#[tauri::command]
pub fn set_show_screenshot_hotkey(
    app: tauri::AppHandle,
    store: State<'_, ConfigStore>,
    hotkey: String,
) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    // 先校验热键格式，避免注册失败后再改配置
    Shortcut::from_str(&hotkey).map_err(|e| format!("无效的热键格式: {e}"))?;

    let gs = app.global_shortcut();
    let old = store.snapshot().hotkeys.show_screenshot.clone();
    if old == hotkey {
        return Ok(());
    }

    if let Err(e) = gs.unregister(old.as_str()) {
        tracing::warn!("注销旧热键 {old} 失败: {e}");
    }
    gs.on_shortcut(hotkey.as_str(), |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            crate::screenshot::start_screenshot(app);
        }
    })
    .map_err(|e| format!("注册热键失败: {e}"))?;

    let mut cfg = (*store.snapshot()).clone();
    cfg.hotkeys.show_screenshot = hotkey;
    store.replace(cfg.clone());
    crate::config::save_config(&cfg);
    Ok(())
}

/// 扫描目录下所有受支持的图片（不递归）
#[tauri::command]
pub fn list_images(dir: String) -> Result<Vec<ImageEntry>, String> {
    let path = Path::new(&dir);
    if !path.is_dir() {
        return Err(format!("不是有效目录: {dir}"));
    }
    Ok(image_scan::scan_directory(path))
}

/// 兜底解码：WebView 不支持的格式（如 tiff）解码后转 PNG data URL
#[tauri::command]
pub fn read_image_data(path: String) -> Result<String, String> {
    let img = image::ImageReader::open(&path)
        .map_err(|e| format!("打开失败: {e}"))?
        .decode()
        .map_err(|e| format!("解码失败: {e}"))?;

    let mut png_bytes = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("编码失败: {e}"))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

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

/// 重注册滚动截图专属热键（注销旧键 → 注册新键 → 持久化）
#[tauri::command]
pub fn set_scroll_capture_hotkey(
    app: tauri::AppHandle,
    store: State<'_, ConfigStore>,
    hotkey: String,
) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    Shortcut::from_str(&hotkey).map_err(|e| format!("无效的热键格式: {e}"))?;

    let gs = app.global_shortcut();
    let old = store.snapshot().hotkeys.scroll_capture.clone();
    if old == hotkey {
        return Ok(());
    }
    if let Err(e) = gs.unregister(old.as_str()) {
        tracing::warn!("注销旧滚动截图热键 {old} 失败: {e}");
    }
    gs.on_shortcut(hotkey.as_str(), |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            crate::screenshot::start_scroll_screenshot(app);
        }
    })
    .map_err(|e| format!("注册热键失败: {e}"))?;

    let mut cfg = (*store.snapshot()).clone();
    cfg.hotkeys.scroll_capture = hotkey;
    store.replace(cfg.clone());
    crate::config::save_config(&cfg);
    Ok(())
}

/// 关于页展示的应用信息。
///
/// 全部取自运行时的真实值：版本与标识来自 tauri.conf.json（`package_info` /
/// `config`），Tauri 版本来自编译期常量，平台来自 `std::env::consts`。
/// 不在前端硬编码，避免 tauri.conf.json 改了而关于页还显示旧值。
#[derive(serde::Serialize)]
pub struct AppInfo {
    pub version: String,
    pub identifier: String,
    pub tauri: String,
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        identifier: app.config().identifier.clone(),
        tauri: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// 用系统默认浏览器打开链接（关于页的仓库 / Releases / 原版仓库 / 许可证）。
///
/// 用 ShellExecuteW 而不是 tauri-plugin-opener：只需要这一个 API，
/// 走已在依赖里的 windows crate 即可，不必新增 crate、npm 包与 capability 授权。
///
/// 只放行 `https://`：这个 url 会被交给系统 shell 处理，若允许 file:// 或任意
/// 自定义协议，就等于给前端开了一个「启动任意程序」的入口。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("只允许打开 https 链接: {url}"));
    }

    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        // ShellExecuteW 要的是以 NUL 结尾的 UTF-16，Vec 需活到调用结束
        let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        let op: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();

        // SAFETY: 两个 PCWSTR 都指向上面已初始化的、以 NUL 结尾的缓冲区，
        // 且在本次调用期间保持存活；hwnd 传 null 表示不依附父窗口。
        let hinstance = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(op.as_ptr()),
                PCWSTR(wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };

        // ShellExecuteW 用返回值 <= 32 表示失败（它不设置 last error）
        let code = hinstance.0 as isize;
        if code <= 32 {
            return Err(format!("打开浏览器失败（ShellExecuteW 返回 {code}）"));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = url;
        Err("当前平台未实现".into())
    }
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

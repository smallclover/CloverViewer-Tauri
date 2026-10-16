//! Tauri 命令：前端可调用的后端接口

use crate::config::{Config, ConfigStore};
use crate::image_scan::{self, ImageEntry};
use std::{fs, path::Path, time::SystemTime};
use tauri::State;

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn get_config(store: State<'_, ConfigStore>) -> Config {
    (*store.snapshot()).clone()
}

#[tauri::command]
pub fn set_config(
    app: tauri::AppHandle,
    store: State<'_, ConfigStore>,
    config: Config,
) -> Result<Config, String> {
    let mut scale_changed = false;
    let saved = store.update_saved(|current| {
        scale_changed = crate::config::normalize_ui_scale(config.ui_scale) != current.ui_scale;
        current.apply_preferences(config);
    })?;
    if scale_changed {
        crate::ui_scale::apply_all(&app);
    }
    crate::tray_menu::refresh(&app);
    Ok(saved)
}

/// 启用或隐藏独立桌宠窗口。窗口创建可能等待 WebView2 的主线程回调，
/// 因此必须作为异步命令执行，不能从主线程同步等待其完成。
#[tauri::command]
pub async fn set_desktop_pet_enabled(
    app: tauri::AppHandle,
    store: State<'_, ConfigStore>,
    switch: State<'_, crate::desktop_pet::DesktopPetSwitchState>,
    enabled: bool,
) -> Result<(), String> {
    crate::desktop_pet::set_enabled(&app, &store, &switch, enabled)
}

/// 改变桌宠缩放比例并立即应用到已显示的独立窗口。
#[tauri::command]
pub fn set_desktop_pet_scale(
    app: tauri::AppHandle,
    store: State<'_, ConfigStore>,
    scale: u16,
) -> Result<(), String> {
    crate::desktop_pet::set_scale(&app, &store, scale)
}

/// 读取虚拟桌面中的全局鼠标物理坐标，供独立桌宠窗口驱动视线。
#[tauri::command]
pub fn get_desktop_pet_cursor_position() -> Option<crate::screenshot::CursorPosition> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        let mut point = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut point) }
            .ok()
            .map(|_| crate::screenshot::CursorPosition {
                x: point.x,
                y: point.y,
            })
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// 长截图在查看器中打开时的临时文件目录。只对这个应用自己创建的目录做维护，
/// 绝不扫描或清理系统 Temp 的其它内容。
pub fn temporary_capture_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("CloverViewer")
}

#[derive(serde::Serialize)]
pub struct CacheSummary {
    pub files: u64,
    pub bytes: u64,
}

#[derive(serde::Serialize)]
pub struct CacheCleanupResult {
    pub files: u64,
    pub bytes: u64,
}

fn temporary_capture_files() -> Vec<(std::path::PathBuf, fs::Metadata)> {
    let Ok(entries) = fs::read_dir(temporary_capture_dir()) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            // file_type 不跟随链接，避免目录内的符号链接把清理范围带到目录外。
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((entry.path(), metadata))
        })
        .collect()
}

#[tauri::command]
pub fn get_cache_summary() -> CacheSummary {
    temporary_capture_files().into_iter().fold(
        CacheSummary { files: 0, bytes: 0 },
        |mut summary, (_, metadata)| {
            summary.files += 1;
            summary.bytes += metadata.len();
            summary
        },
    )
}

/// 删除指定时间以前创建（以最后修改时间为准）的应用临时截图。
/// `older_than_hours = 0` 代表删除全部。
#[tauri::command]
pub fn clear_temp_cache(older_than_hours: u32) -> Result<CacheCleanupResult, String> {
    let cutoff = SystemTime::now().checked_sub(std::time::Duration::from_secs(
        u64::from(older_than_hours) * 3600,
    ));
    let mut result = CacheCleanupResult { files: 0, bytes: 0 };
    for (path, metadata) in temporary_capture_files() {
        let expired = older_than_hours == 0
            || cutoff
                .and_then(|time| metadata.modified().ok().map(|modified| modified < time))
                .unwrap_or(false);
        if expired {
            let bytes = metadata.len();
            match fs::remove_file(&path) {
                Ok(()) => {
                    result.files += 1;
                    result.bytes += bytes;
                }
                // 临时文件可能刚好被查看器占用；跳过它比让整个清理失败更合理。
                Err(error) => tracing::warn!("无法删除临时缓存 {}: {error}", path.display()),
            }
        }
    }
    Ok(result)
}

/// 设置开机自启（写/删 HKCU\...\Run 注册表）
#[tauri::command]
pub fn set_launch_on_startup(
    store: State<'_, ConfigStore>,
    enabled: bool,
) -> Result<Config, String> {
    let previous = store.snapshot().launch_on_startup;
    crate::startup::update_preference(
        previous,
        enabled,
        crate::startup::set_launch_on_startup,
        || store.update_saved(|config| config.launch_on_startup = enabled),
    )
}

#[tauri::command]
pub fn set_show_screenshot_hotkey(
    app: tauri::AppHandle,
    store: State<'_, ConfigStore>,
    hotkey: String,
) -> Result<(), String> {
    crate::hotkeys::change(&app, &store, crate::hotkeys::Action::Screenshot, hotkey)
}

#[tauri::command]
pub fn set_scroll_capture_hotkey(
    app: tauri::AppHandle,
    store: State<'_, ConfigStore>,
    hotkey: String,
) -> Result<(), String> {
    crate::hotkeys::change(&app, &store, crate::hotkeys::Action::Scroll, hotkey)
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

/// 只接受现有文件路径，打开其父文件夹；不把文件路径交给 ShellExecute 执行。
#[tauri::command]
pub fn open_containing_folder(path: String) -> Result<(), String> {
    let file = Path::new(&path);
    if !file.is_absolute() || !file.is_file() {
        return Err("图片文件不存在".into());
    }
    let folder = file.parent().ok_or("无法确定图片所在文件夹")?;

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let wide: Vec<u16> = folder
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let op: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
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
        let code = hinstance.0 as isize;
        if code <= 32 {
            return Err(format!("打开文件夹失败（ShellExecuteW 返回 {code}）"));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = folder;
        Err("当前平台未实现".into())
    }
}

/// 扫描目录下所有受支持的图片（不递归）
#[tauri::command]
pub async fn list_images(dir: String) -> Result<Vec<ImageEntry>, String> {
    crate::image_tasks::run(move || {
        let path = Path::new(&dir);
        if !path.is_dir() {
            return Err(format!("不是有效目录: {dir}"));
        }
        Ok(image_scan::scan_directory(path))
    })
    .await
}

/// 兜底解码：WebView 不支持的格式（如 tiff）解码后转 PNG data URL
#[tauri::command]
pub async fn read_image_data(path: String) -> Result<String, String> {
    crate::image_tasks::run(move || crate::image_io::read_data_url(path)).await
}

/// 返回适合 Canvas 编辑的 data URL。asset protocol 在 WebView2 中可展示，
/// 但它不保证满足 Canvas 的同源导出要求；编辑时统一转为内联数据，避免 tainted canvas。
#[tauri::command]
pub async fn read_editable_image_data(path: String) -> Result<String, String> {
    crate::image_tasks::run(move || crate::image_io::read_editable_data_url(path)).await
}

/// 将前端 Canvas 的 PNG 以用户选择的格式写入指定位置。
///
/// 解码与编码均在 Rust 侧完成，避免 WebView2 对 WebP 编码支持差异影响导出结果。
#[tauri::command]
pub async fn save_edited_image(path: String, png: String, format: String) -> Result<(), String> {
    crate::image_tasks::run(move || crate::image_io::save_edited(path, png, format)).await
}

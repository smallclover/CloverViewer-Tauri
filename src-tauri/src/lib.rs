//! CloverViewer-Tauri 应用入口
//!
//! 从 CloverViewer (egui/eframe 版) 迁移的核心结构：
//! - 单实例 + 二次启动唤起主窗口
//! - 托盘（左键显示 / 右键菜单：截图、滚动截图、设置与退出）
//! - 全局热键 Alt+S 进截图、Alt+Shift+S 进滚动截图（被占用时自动降级）
//! - 窗口位置/尺寸持久化（写入同一份 config.json）
//! - minimize_on_close：关窗隐藏到托盘

mod atomic_file;
mod commands;
mod config;
mod desktop_pet;
mod hotkeys;
mod image_info;
mod image_io;
mod image_scan;
mod image_tasks;
mod lan_share;
mod lan_share_page;
pub mod mcp;
mod ocr;
pub use ocr::run_worker as run_ocr_worker;
mod screenshot;
// 声明为 pub：延迟探针（examples 下的二进制）要复用同一条捕获路径做基准测试，不经过 UI。
pub mod screenshot_capture;
mod screenshot_window;
/// 滚动截图（长截图）核心。
/// `pub` 是为了让开发用探针 `src-tauri/examples/scroll_probe.rs` 复用同一套实现
/// （兼容性探测 + 完整会话 CLI + 标尺校验）。
pub mod scroll_capture;
mod startup;
mod temp_cache;
mod thumbnails;
mod tray_menu;
mod ui_scale;
mod window_decoration;
mod window_keyboard;
mod window_shell_geometry;

use config::ConfigStore;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

const MAIN_WINDOW: &str = "main";

/// 使用用户界面倍率的窗口。
///
/// 只有主查看器和截图浮层有完整的界面层（工具栏、面板、网格）。桌宠是纯角色窗口，
/// 缩放它只会让角色忽大忽小，因此排除在外。
fn uses_ui_scale(label: &str) -> bool {
    label == MAIN_WINDOW || label == screenshot::WINDOW_LABEL
}

/// 启动阶段要告诉用户的提示（目前只有热键冲突）。
///
/// 为什么不直接在 setup 里 emit：那时前端刚开始加载、还没挂上监听，事件会丢。
/// 改成「存起来 + 前端启动后主动取」，就没有竞态。
#[derive(Default)]
pub struct StartupNotices(std::sync::Mutex<Vec<StartupNotice>>);

#[derive(Clone, serde::Serialize)]
pub struct StartupNotice {
    /// "hotkey_fallback" = 想要的组合被占用、已临时改用别的；"hotkey_conflict" = 完全没注册上
    pub kind: String,
    pub wanted: Option<String>,
    pub used: Option<String>,
}

impl StartupNotices {
    fn push(&self, n: StartupNotice) {
        if let Ok(mut g) = self.0.lock() {
            g.push(n);
        }
    }
}

#[tauri::command]
fn take_startup_notices(state: tauri::State<'_, StartupNotices>) -> Vec<StartupNotice> {
    state
        .0
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default()
}

/// 主窗口最小逻辑尺寸，与 tauri.conf.json 的 minWidth/minHeight 一致。
/// 用于过滤启动阶段上报的瞬时小尺寸：Windows 上 WebView 初始化偶尔会把窗口
/// 临时缩到一个远低于正常值的小尺寸，若被 `Resized` 处理器原样落盘，下次启动
/// 就会把主窗口恢复得很小。低于该下限（换算成当前缩放的物理像素）的一律忽略。
const MIN_WINDOW_LOGICAL_W: f32 = 640.0;
const MIN_WINDOW_LOGICAL_H: f32 = 480.0;

/// 把主窗口带到前台并聚焦。
///
/// 三个触发点共用（单实例二次启动 / 托盘菜单「显示」 / 托盘左键点击）：
/// - show + unminimize：同时覆盖「隐藏到托盘」与「最小化到任务栏」两种状态，
///   否则仅 show 不会把最小化窗口还原（Windows 上表现为点托盘没反应）。
/// - Windows 上本进程不是前台进程、后台调用 SetForegroundWindow 会被系统拒绝，
///   窗口可能只恢复但被其它窗口盖住；用开关 always_on_top 强制抬到最前再还原层级。
fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        #[cfg(target_os = "windows")]
        {
            let _ = w.set_always_on_top(true);
            let _ = w.set_always_on_top(false);
        }
        let _ = w.set_focus();
    }
}

fn request_app_exit(app: &AppHandle) {
    show_main_window(app);
    let _ = app.emit_to(MAIN_WINDOW, "app-exit-requested", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = config::load_config();
    let hotkey_show_screenshot = config.hotkeys.show_screenshot.clone();
    let hotkey_scroll_capture = config.hotkeys.scroll_capture.clone();
    let startup_pos = config.window_pos;
    let startup_size = config.window_size;
    let launch_on_startup = config.launch_on_startup;
    let cache_cleanup_after_hours = config.cache_cleanup_after_hours;
    // --startup：由开机自启触发，启动后隐藏到托盘（不显示主窗口）
    let start_in_background = std::env::args().any(|a| a == "--startup");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ConfigStore::new(config))
        .manage(hotkeys::HotkeyBindings::default())
        .manage(desktop_pet::DesktopPetSwitchState::default())
        .manage(desktop_pet::DesktopPetMenuState::default())
        .manage(window_decoration::DecorationState::default())
        .manage(thumbnails::ThumbnailStore::new(512))
        .manage(screenshot::ScreenshotStore::new())
        .manage(lan_share::LanShareStore::new())
        .manage(scroll_capture::ScrollCaptureSession::new())
        .manage(StartupNotices::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            hotkeys::get_active_hotkeys,
            commands::quit_app,
            commands::set_config,
            window_decoration::initialize_window_decoration,
            window_decoration::window_shell_capture_ready,
            tray_menu::start_capture,
            commands::set_desktop_pet_enabled,
            commands::set_desktop_pet_scale,
            commands::get_desktop_pet_cursor_position,
            desktop_pet::show_desktop_pet_menu,
            commands::get_cache_summary,
            commands::clear_temp_cache,
            commands::set_launch_on_startup,
            commands::set_show_screenshot_hotkey,
            commands::set_scroll_capture_hotkey,
            commands::list_images,
            commands::read_image_data,
            commands::read_editable_image_data,
            commands::save_edited_image,
            commands::get_app_info,
            commands::open_url,
            commands::open_containing_folder,
            thumbnails::get_thumbnail,
            image_info::get_image_info,
            screenshot::get_screenshot_data,
            screenshot::get_screenshot_frame,
            screenshot_window::prepare_screenshot_window,
            screenshot_window::sync_screenshot_window,
            screenshot::take_scroll_start_mode,
            screenshot::close_screenshot,
            screenshot::finish_screenshot,
            screenshot::copy_text,
            screenshot::copy_image_file,
            screenshot::pick_window_at,
            screenshot::screenshot_ui_ready,
            lan_share::start_lan_share,
            lan_share::start_image_lan_share,
            lan_share::stop_lan_share,
            lan_share::is_lan_share_active,
            ocr::ocr_image,
            ocr::ocr_image_document,
            ocr::models::get_ocr_model_status,
            ocr::models::download_ocr_model,
            ocr::models::cancel_ocr_model_download,
            ocr::models::remove_ocr_model,
            scroll_capture::tauri::start_scroll_capture,
            scroll_capture::tauri::stop_scroll_capture,
            scroll_capture::tauri::scroll_capture_progress,
            scroll_capture::tauri::finish_scroll_capture,
            scroll_capture::tauri::discard_scroll_capture,
            scroll_capture::tauri::scroll_capture_running,
            take_startup_notices,
        ])
        .setup(move |app| {
            match app.path().app_cache_dir() {
                Ok(dir) => app
                    .state::<thumbnails::ThumbnailStore>()
                    .configure_disk_cache(dir.join("thumbnail-v1")),
                Err(error) => tracing::warn!("无法定位缩略图磁盘缓存目录: {error}"),
            }
            // 只在启动时清一次，避免用户当前正在查看的临时长截图被后台删掉。
            if cache_cleanup_after_hours > 0 {
                match commands::clear_temp_cache(cache_cleanup_after_hours) {
                    Ok(result) if result.failed_files > 0 => tracing::warn!(
                        "自动清理临时缓存：已清理 {} 个，{} 个未能清理：{}",
                        result.files,
                        result.failed_files,
                        result.first_error.as_deref().unwrap_or_default()
                    ),
                    Ok(result) if result.files > 0 => tracing::info!(
                        "已自动清理 {} 个临时截图（{} 字节）",
                        result.files,
                        result.bytes
                    ),
                    Ok(_) => {}
                    Err(error) => tracing::warn!("自动清理临时缓存失败: {error}"),
                }
            }
            // 显式设置窗口/任务栏图标：Tauri 2 窗口默认不套用 default_window_icon，
            // 否则窗口内部/任务栏图标是系统默认而非真实图标。
            if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                window_keyboard::prevent_empty_menu_loop(&win);
                if let Some(icon) = app.default_window_icon() {
                    let _ = win.set_icon(icon.clone());
                }
            }

            // 恢复上次窗口位置/尺寸
            if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                if let Some((x, y)) = startup_pos {
                    // 跳过 Windows 最小化虚拟坐标（±32000），否则主窗口被
                    // set 到屏幕外，表现为「主窗口消失」。
                    if x > -32000.0 && y > -32000.0 {
                        let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                    }
                }
                if let Some((w, h)) = startup_size {
                    if w > 0.0 && h > 0.0 {
                        // 过滤过小的持久化尺寸：启动阶段 WebView 有时会上报一次瞬时
                        // 小尺寸，若被记进 config.json，下次打开主窗口就会变得很小。
                        // 以窗口最小逻辑尺寸（640x480）× 当前缩放作为下限，低于则忽略，
                        // 保留 tauri.conf.json 里的默认 1024x768。
                        let scale = win.scale_factor().map(|s| s as f32).unwrap_or(1.0).max(0.5);
                        if w >= MIN_WINDOW_LOGICAL_W * scale && h >= MIN_WINDOW_LOGICAL_H * scale {
                            let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                        } else {
                            tracing::warn!("忽略过小的持久化窗口尺寸 {w}x{h}");
                        }
                    }
                }
                // 恢复用户保存的界面倍率，默认 100%。
                ui_scale::apply(&win);
            }

            hotkeys::register_startup(
                app.handle(),
                &hotkey_show_screenshot,
                &hotkey_scroll_capture,
            );

            tray_menu::create(app)?;
            window_decoration::start_tracking(app.handle().clone());

            // 开机自启：每次启动同步一次注册表项（保证 exe 路径最新）
            if launch_on_startup {
                if let Err(e) = crate::startup::set_launch_on_startup(true) {
                    tracing::warn!("同步开机自启注册表项失败: {e}");
                }
            }

            // --startup：隐藏到托盘；否则显示主窗口
            if start_in_background {
                if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = win.hide();
                }
            } else if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                let _ = win.show();
                let _ = win.set_focus();
            }

            Ok(())
        })
        // 页面（重新）加载后重新对齐界面密度：WebView2 的缩放按站点记忆，
        // 首次导航到真实页面、以及 dev 模式整页刷新，都可能把它丢回 1.0。
        .on_page_load(|webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let label = webview.label().to_string();
            if !uses_ui_scale(&label) {
                return;
            }
            let app = webview.window().app_handle().clone();
            if let Some(window) = app.get_webview_window(&label) {
                ui_scale::forget_applied(&label);
                ui_scale::apply(&window);
            }
        })
        .on_window_event(|window, event| {
            // 换屏后保持用户选择的倍率，系统 DPI 由 WebView 处理。
            if uses_ui_scale(window.label()) {
                match event {
                    tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                        if let Some(target) = window.app_handle().get_webview_window(window.label())
                        {
                            ui_scale::apply(&target);
                        }
                    }
                    // 销毁后重建 = 全新 WebView（缩放回到 1.0），旧记录必须丢掉。
                    tauri::WindowEvent::Destroyed => ui_scale::forget(window.label()),
                    _ => {}
                }
            }

            if window.label() != MAIN_WINDOW {
                return;
            }
            window_decoration::sync(window.app_handle());
            let store = window.app_handle().state::<ConfigStore>();

            match event {
                // 关窗 → 按配置决定：最小化到托盘 或 真正退出
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if store.snapshot().minimize_on_close {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    window_decoration::record_bounds(window.app_handle());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("初始化 CloverViewer-Tauri 失败")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // 退出时保存配置（窗口位置/尺寸等）
                let store = app.state::<ConfigStore>();
                if let Err(error) = config::save_config(&store.snapshot()) {
                    tracing::error!("保存退出配置失败: {error}");
                }
            }
        });
}

/// 隐藏控制台窗口（release 模式下使用）。
///
/// 因为 windows_subsystem 改为 "console" 以支持 MCP stdio，
/// GUI 模式需要手动隐藏控制台窗口。
#[cfg(all(not(debug_assertions), target_os = "windows"))]
pub fn hide_console_window() {
    use windows::Win32::System::Console::GetConsoleWindow;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};

    unsafe {
        let hwnd = GetConsoleWindow();
        if !hwnd.is_invalid() {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

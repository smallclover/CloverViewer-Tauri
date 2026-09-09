//! CloverViewer-Tauri 应用入口
//!
//! 从 CloverViewer (egui/eframe 版) 迁移的核心结构：
//! - 单实例 + 二次启动唤起主窗口
//! - 托盘（左键显示 / 右键菜单：显示、退出）
//! - 全局热键 Alt+S（Phase 3 接截图，当前转发给前端占位）
//! - 窗口位置/尺寸持久化（写入同一份 config.json）
//! - minimize_on_close：关窗隐藏到托盘

mod commands;
mod config;
mod image_info;
mod image_scan;
pub mod mcp;
mod ocr;
mod screenshot;
mod startup;
mod thumbnails;

use config::ConfigStore;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const MAIN_WINDOW: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = config::load_config();
    let hotkey_show_screenshot = config.hotkeys.show_screenshot.clone();
    let startup_pos = config.window_pos;
    let startup_size = config.window_size;
    let launch_on_startup = config.launch_on_startup;
    // --startup：由开机自启触发，启动后隐藏到托盘（不显示主窗口）
    let start_in_background = std::env::args().any(|a| a == "--startup");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ConfigStore::new(config))
        .manage(thumbnails::ThumbnailStore::new(512))
        .manage(screenshot::ScreenshotStore::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::set_launch_on_startup,
            commands::set_show_screenshot_hotkey,
            commands::list_images,
            commands::read_image_data,
            thumbnails::get_thumbnail,
            image_info::get_image_info,
            screenshot::get_screenshot_data,
            screenshot::close_screenshot,
            screenshot::finish_screenshot,
            screenshot::copy_text,
            screenshot::pick_window_at,
            screenshot::screenshot_ui_ready,
            ocr::ocr_image,
        ])
        .setup(move |app| {
            // 显式设置窗口/任务栏图标：Tauri 2 窗口默认不套用 default_window_icon，
            // 否则窗口内部/任务栏图标是系统默认而非真实图标。
            if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
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
                        let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                    }
                }
            }

            // 注册全局截图热键（直接进入截图模式）
            let gs = app.global_shortcut();
            if let Err(e) = gs.on_shortcut(hotkey_show_screenshot.as_str(), |app, _sc, event| {
                if event.state() == ShortcutState::Pressed {
                    screenshot::start_screenshot(app);
                }
            }) {
                tracing::warn!("热键 {hotkey_show_screenshot} 注册失败: {e}");
            }

            // 托盘
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("CloverViewer")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

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
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW {
                return;
            }
            let store = window.app_handle().state::<ConfigStore>();

            match event {
                // 关窗 → 按配置决定：最小化到托盘 或 真正退出
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if store.snapshot().minimize_on_close {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // 记录窗口位置/尺寸（退出时统一落盘）
                // 过滤 Windows 最小化虚拟坐标（±32000）与零尺寸：窗口被
                // hide/minimize 时 Windows 会发出 Moved(-32000,-32000) /
                // Resized(0,0)，若原样持久化，下次启动会恢复到屏幕外 / 零
                // 尺寸，表现为「主窗口消失」。
                tauri::WindowEvent::Moved(pos) => {
                    if pos.x <= -32000 || pos.y <= -32000 {
                        return;
                    }
                    let mut cfg = (*store.snapshot()).clone();
                    cfg.window_pos = Some((pos.x as f32, pos.y as f32));
                    store.replace(cfg);
                }
                tauri::WindowEvent::Resized(size) => {
                    if size.width == 0 || size.height == 0 {
                        return;
                    }
                    let mut cfg = (*store.snapshot()).clone();
                    cfg.window_size = Some((size.width as f32, size.height as f32));
                    store.replace(cfg);
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
                config::save_config(&store.snapshot());
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
    use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};

    unsafe {
        let hwnd = GetConsoleWindow();
        if !hwnd.is_invalid() {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

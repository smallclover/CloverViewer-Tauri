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
/// 滚动截图（长截图）核心。
/// `pub` 是为了让开发用探针 `src-tauri/examples/scroll_probe.rs` 复用同一套实现
/// （兼容性探测 + 完整会话 CLI + 标尺校验，见 SCROLL_CAPTURE_PLAN.md 附录 A）。
pub mod scroll_capture;
mod startup;
mod thumbnails;

use config::ConfigStore;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const MAIN_WINDOW: &str = "main";

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = config::load_config();
    let hotkey_show_screenshot = config.hotkeys.show_screenshot.clone();
    let hotkey_scroll_capture = config.hotkeys.scroll_capture.clone();
    let startup_pos = config.window_pos;
    let startup_size = config.window_size;
    let launch_on_startup = config.launch_on_startup;
    // --startup：由开机自启触发，启动后隐藏到托盘（不显示主窗口）
    let start_in_background = std::env::args().any(|a| a == "--startup");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ConfigStore::new(config))
        .manage(thumbnails::ThumbnailStore::new(512))
        .manage(screenshot::ScreenshotStore::new())
        .manage(scroll_capture::ScrollCaptureSession::new())
        .manage(StartupNotices::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::set_launch_on_startup,
            commands::set_show_screenshot_hotkey,
            commands::set_scroll_capture_hotkey,
            commands::list_images,
            commands::read_image_data,
            commands::get_app_info,
            commands::open_url,
            thumbnails::get_thumbnail,
            image_info::get_image_info,
            screenshot::get_screenshot_data,
            screenshot::take_scroll_start_mode,
            screenshot::close_screenshot,
            screenshot::finish_screenshot,
            screenshot::copy_text,
            screenshot::pick_window_at,
            screenshot::screenshot_ui_ready,
            ocr::ocr_image,
            scroll_capture::start_scroll_capture,
            scroll_capture::stop_scroll_capture,
            scroll_capture::scroll_capture_progress,
            scroll_capture::set_scroll_hud_safe,
            scroll_capture::finish_scroll_capture,
            scroll_capture::discard_scroll_capture,
            scroll_capture::has_scroll_capture_result,
            scroll_capture::scroll_capture_running,
            take_startup_notices,
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
                        // 过滤过小的持久化尺寸：启动阶段 WebView 有时会上报一次瞬时
                        // 小尺寸，若被记进 config.json，下次打开主窗口就会变得很小。
                        // 以窗口最小逻辑尺寸（640x480）× 当前缩放作为下限，低于则忽略，
                        // 保留 tauri.conf.json 里的默认 1024x768。
                        let scale = win
                            .scale_factor()
                            .map(|s| s as f32)
                            .unwrap_or(1.0)
                            .max(0.5);
                        if w >= MIN_WINDOW_LOGICAL_W * scale && h >= MIN_WINDOW_LOGICAL_H * scale {
                            let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                        } else {
                            tracing::warn!("忽略过小的持久化窗口尺寸 {w}x{h}");
                        }
                    }
                }
            }

            // 注册全局截图热键（直接进入截图模式）
            let gs = app.global_shortcut();
            let hk_log = hotkey_show_screenshot.clone();
            if let Err(e) = gs.on_shortcut(hotkey_show_screenshot.as_str(), move |app, _sc, event| {
                if event.state() == ShortcutState::Pressed {
                    tracing::info!("热键触发: 截图 {hk_log}");
                    screenshot::start_screenshot(app);
                }
            }) {
                tracing::warn!("热键 {hotkey_show_screenshot} 注册失败: {e}");
            }

            // 注册滚动截图专属热键（按下直接进「滚动截图待框选」态，省掉 Alt+S → S 两步）。
            //
            // 热键冲突在这类机器上是**常态**（微信/QQ/输入法/别的截图工具都在抢全局热键）：
            // 被占用时按候选列表自动降级，并把「想用的 / 实际生效的」一并告诉前端去提示用户
            // （PixPin 也是启动时提示冲突的做法）。注册不上也不影响其它入口（工具栏图标 / S 键）。
            if hotkey_scroll_capture == hotkey_show_screenshot {
                app.state::<StartupNotices>().push(StartupNotice {
                    kind: "hotkey_conflict".into(),
                    wanted: Some(hotkey_scroll_capture.clone()),
                    used: None,
                });
                tracing::warn!("滚动截图热键与截图热键相同（{hotkey_scroll_capture}），跳过注册");
            } else {
                let mut candidates = vec![hotkey_scroll_capture.clone()];
                for c in ["Alt+Shift+A", "Ctrl+Alt+S", "Ctrl+Shift+A", "Alt+Shift+Z"] {
                    if !candidates.iter().any(|x| x == c) {
                        candidates.push(c.to_string());
                    }
                }
                let mut bound: Option<String> = None;
                for (idx, cand) in candidates.iter().enumerate() {
                    let cand_log = cand.clone();
                    let r = gs.on_shortcut(cand.as_str(), move |app, _sc, event| {
                        if event.state() == ShortcutState::Pressed {
                            tracing::info!("热键触发: 滚动截图 {cand_log}");
                            screenshot::start_scroll_screenshot(app);
                        }
                    });
                    match r {
                        Ok(_) => {
                            if idx > 0 {
                                app.state::<StartupNotices>().push(StartupNotice {
                                    kind: "hotkey_fallback".into(),
                                    wanted: Some(hotkey_scroll_capture.clone()),
                                    used: Some(cand.clone()),
                                });
                                tracing::warn!(
                                    "滚动截图热键 {hotkey_scroll_capture} 被占用，临时改用 {cand}"
                                );
                            }
                            bound = Some(cand.clone());
                            break;
                        }
                        Err(e) => tracing::warn!("滚动截图热键 {cand} 注册失败: {e}"),
                    }
                }
                if bound.is_none() {
                    app.state::<StartupNotices>().push(StartupNotice {
                        kind: "hotkey_conflict".into(),
                        wanted: Some(hotkey_scroll_capture.clone()),
                        used: None,
                    });
                }
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
                        show_main_window(app);
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
                        show_main_window(&app);
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
                    // 过滤启动阶段的瞬时小尺寸（低于窗口最小逻辑尺寸的一律不落盘），
                    // 避免污染 config.json，导致下次打开主窗口变小。
                    let scale = window.scale_factor().unwrap_or(1.0) as f32;
                    if (size.width as f32) < MIN_WINDOW_LOGICAL_W * scale
                        || (size.height as f32) < MIN_WINDOW_LOGICAL_H * scale
                    {
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

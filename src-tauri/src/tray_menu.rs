//! 托盘常驻入口：显示主窗口、截图、滚动截图、设置与退出。
use crate::config::{ConfigStore, Language};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let config = app.state::<ConfigStore>().snapshot();
    let active = crate::hotkeys::active(app);
    let labels = match config.language {
        Language::Zh => [
            "显示主窗口",
            "截图",
            "滚动截图",
            "设置…",
            "退出 CloverViewer",
        ],
        Language::En => [
            "Show main window",
            "Screenshot",
            "Scrolling screenshot",
            "Settings…",
            "Quit CloverViewer",
        ],
        Language::Ja => [
            "メインウィンドウを表示",
            "スクリーンショット",
            "スクロールスクリーンショット",
            "設定…",
            "CloverViewer を終了",
        ],
    };
    let show = MenuItem::with_id(app, "tray-show", labels[0], true, None::<&str>)?;
    // 快捷键仅显示文字，继续沿用已有的全局热键注册。
    let screenshot = MenuItem::with_id(
        app,
        "tray-screenshot",
        format!(
            "{}\t{}",
            labels[1],
            active.show_screenshot.as_deref().unwrap_or("—")
        ),
        true,
        None::<&str>,
    )?;
    let scroll = MenuItem::with_id(
        app,
        "tray-scroll",
        format!(
            "{}\t{}",
            labels[2],
            active.scroll_capture.as_deref().unwrap_or("—")
        ),
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "tray-settings", labels[3], true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", labels[4], true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &show,
            &screenshot,
            &scroll,
            &separator1,
            &settings,
            &separator2,
            &quit,
        ],
    )
}

pub fn refresh(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Err(error) = menu(app).and_then(|menu| tray.set_menu(Some(menu))) {
            tracing::warn!("Unable to refresh tray menu: {error}");
        }
    }
}

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    let menu = menu(app.handle())?;
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("CloverViewer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => crate::show_main_window(app),
            "tray-screenshot" => crate::screenshot::start_screenshot(app),
            "tray-scroll" => crate::screenshot::start_scroll_screenshot(app),
            "tray-settings" => {
                crate::show_main_window(app);
                let _ = app.emit_to(
                    "main",
                    "tray-action",
                    serde_json::json!({"action": "settings"}),
                );
            }
            "tray-quit" => crate::request_app_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                crate::show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub fn start_capture(app: AppHandle, scroll: bool) {
    if scroll {
        crate::screenshot::start_scroll_screenshot(&app);
    } else {
        crate::screenshot::start_screenshot(&app);
    }
}

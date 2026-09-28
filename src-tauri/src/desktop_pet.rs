//! 桌面小宠物：一个不出现在任务栏的透明独立窗口。
//!
//! 窗口与主查看器解耦，截图前会临时隐藏，因此不会被捕获进图片。

use crate::config::{save_config, ConfigStore};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const WINDOW_LABEL: &str = "desktop-pet";
const MIN_SCALE: u16 = 60;
const MAX_SCALE: u16 = 200;
const BASE_WIDTH: f64 = 360.0;
const BASE_HEIGHT: f64 = 540.0;

/// 允许“关闭”越过仍在创建 WebView 的“开启”（包括前端超时取消），
/// 并防止过期请求稍后重新显示桌宠。
#[derive(Default)]
pub struct DesktopPetSwitchState {
    generation: AtomicU64,
    creation: Mutex<()>,
    commit: Mutex<()>,
}

fn normalize_scale(scale: u16) -> u16 {
    scale.clamp(MIN_SCALE, MAX_SCALE)
}

fn dimensions(scale: u16) -> (f64, f64) {
    let multiplier = f64::from(normalize_scale(scale)) / 100.0;
    (BASE_WIDTH * multiplier, BASE_HEIGHT * multiplier)
}

fn create_window(app: &AppHandle, scale: u16) -> Result<WebviewWindow, String> {
    let (width, height) = dimensions(scale);
    let window = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("desktop-pet.html".into()),
    )
    .title("CloverViewer Desktop Pet")
    .transparent(true)
    .decorations(false)
    // Windows 会为无边框窗口画出矩形 DWM 阴影；桌宠应只留下角色本身。
    .shadow(false)
    .always_on_top(true)
    // 透明窗绝不获得焦点；否则某些 Windows/WebView2 组合会让输入看似「卡住」。
    .focused(false)
    .skip_taskbar(true)
    .resizable(false)
    .inner_size(width, height)
    .visible(false)
    .build()
    .map_err(|error| format!("创建桌宠窗口失败: {error}"))?;

    // 首次显示在主屏右下角；之后用户可直接拖动角色移动窗口。
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let position = monitor.position();
        let x = position.x + size.width as i32 - ((width + 24.0) * scale) as i32;
        let y = position.y + size.height as i32 - ((height + 44.0) * scale) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    // 在 Live2D 资源完成加载前，透明窗口必须穿透鼠标。否则渲染失败或窗口
    // 尚未显示角色时，会留下一块看不见但会拦截主窗口操作的区域；前端只会在
    // 成功挂载角色后才把鼠标事件交给桌宠，用于拖动窗口。
    if let Err(error) = window.set_ignore_cursor_events(true) {
        let _ = window.close();
        return Err(format!("桌宠窗口无法启用鼠标穿透: {error}"));
    }
    Ok(window)
}

fn window(
    app: &AppHandle,
    scale: u16,
    state: &DesktopPetSwitchState,
) -> Result<WebviewWindow, String> {
    let _creation = state.creation.lock().map_err(|error| error.to_string())?;
    app.get_webview_window(WINDOW_LABEL)
        .map(Ok)
        .unwrap_or_else(|| create_window(app, scale))
}

pub fn set_enabled(
    app: &AppHandle,
    store: &ConfigStore,
    state: &DesktopPetSwitchState,
    enabled: bool,
) -> Result<(), String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let pet_window = if enabled {
        let scale = store.snapshot().desktop_pet_scale;
        Some(window(app, scale, state)?)
    } else {
        None
    };

    let _commit = state.commit.lock().map_err(|error| error.to_string())?;
    if state.generation.load(Ordering::SeqCst) != generation {
        return Ok(());
    }

    if let Some(window) = pet_window {
        window
            .show()
            .map_err(|error| format!("显示桌宠失败: {error}"))?;
    } else if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window
            .hide()
            .map_err(|error| format!("隐藏桌宠失败: {error}"))?;
    }

    let mut config = (*store.snapshot()).clone();
    config.desktop_pet_enabled = enabled;
    store.replace(config.clone());
    save_config(&config);
    Ok(())
}

/// 让缩放前后的窗口中心保持不变，避免在屏幕右下角放大的桌宠被裁到屏幕外。
fn apply_scale(window: &WebviewWindow, scale: u16) -> Result<(), String> {
    let old_size = window.inner_size().ok();
    let old_position = window.outer_position().ok();
    let display_scale = window.scale_factor().unwrap_or(1.0);
    let (width, height) = dimensions(scale);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| format!("调整桌宠尺寸失败: {error}"))?;

    if let (Some(old_size), Some(old_position)) = (old_size, old_position) {
        let width_delta = (width * display_scale).round() as i32 - old_size.width as i32;
        let height_delta = (height * display_scale).round() as i32 - old_size.height as i32;
        let _ = window.set_position(PhysicalPosition::new(
            old_position.x - width_delta / 2,
            old_position.y - height_delta / 2,
        ));
    }
    Ok(())
}

pub fn set_scale(app: &AppHandle, store: &ConfigStore, scale: u16) -> Result<(), String> {
    let mut config = (*store.snapshot()).clone();
    config.desktop_pet_scale = normalize_scale(scale);
    store.replace(config.clone());
    save_config(&config);

    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        apply_scale(&window, config.desktop_pet_scale)?;
    }
    Ok(())
}

pub fn restore_after_screenshot(app: &AppHandle) {
    if app.state::<ConfigStore>().snapshot().desktop_pet_enabled {
        // 截图只恢复此前存在的桌宠；不要在截图结束的主线程上创建 WebView。
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.show();
        }
    }
}

pub fn hide_for_screenshot(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
}

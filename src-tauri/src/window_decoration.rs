//! 单个透明主窗口：保留可见面板大小，为角色在客户区内预留绘制空间。
use crate::{
    config::ConfigStore,
    window_shell_geometry::{self as geometry, Insets, Layout},
};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Condvar, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Default)]
pub struct DecorationState {
    ready: AtomicBool,
    insets: Mutex<Insets>,
    input_insets: Mutex<Insets>,
    minimum: Mutex<Option<PhysicalSize<u32>>>,
    emitted: Mutex<Option<Layout>>,
    syncing: Mutex<()>,
    suspended: AtomicBool,
    capture_id: AtomicU64,
    acknowledged: Mutex<u64>,
    capture_ready: Condvar,
    restore_main: AtomicBool,
}

#[tauri::command]
pub async fn initialize_window_decoration(app: AppHandle) -> Result<Layout, String> {
    app.state::<DecorationState>()
        .ready
        .store(true, Ordering::SeqCst);
    apply(&app).ok_or_else(|| "Window shell is unavailable".into())
}

#[tauri::command]
pub fn window_shell_capture_ready(window: WebviewWindow, capture_id: u64) {
    if window.label() != "main" {
        return;
    }
    let state = window.app_handle().state::<DecorationState>();
    *state
        .acknowledged
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = capture_id;
    state.capture_ready.notify_all();
}

fn current_layout(app: &AppHandle, main: &WebviewWindow) -> Layout {
    let config = app.state::<ConfigStore>().snapshot();
    let maximized = main.is_maximized().unwrap_or(false) || main.is_fullscreen().unwrap_or(false);
    let mut model = geometry::layout(
        config.window_decoration,
        config.window_decoration_scale,
        main.scale_factor().unwrap_or(1.0),
        maximized,
    );
    let state = app.state::<DecorationState>();
    if state.suspended.load(Ordering::SeqCst) {
        model.style = crate::config::WindowDecoration::Off;
        model.capture_id = Some(state.capture_id.load(Ordering::SeqCst));
    }
    model
}

fn apply(app: &AppHandle) -> Option<Layout> {
    let state = app.state::<DecorationState>();
    if !state.ready.load(Ordering::SeqCst) {
        return None;
    }
    let _syncing = state.syncing.try_lock().ok()?;
    let main = app.get_webview_window("main")?;
    if main.is_minimized().unwrap_or(true) {
        return None;
    }
    let model = current_layout(app, &main);
    let maximized = main.is_maximized().unwrap_or(false) || main.is_fullscreen().unwrap_or(false);
    if !maximized {
        let old = *state.insets.lock().ok()?;
        let next = model.insets;
        if old != next {
            let outer = main.outer_position().ok()?;
            let size = main.inner_size().ok()?;
            let panel_width = size.width.saturating_sub(old.left + old.right);
            let panel_height = size.height.saturating_sub(old.top + old.bottom);
            // 先提交留白，以免原生移动/缩放事件再次将旧留白加到新窗口上。
            *state.insets.lock().ok()? = next;
            let target = PhysicalSize::new(
                panel_width + next.left + next.right,
                panel_height + next.top + next.bottom,
            );
            let dpi = main.scale_factor().unwrap_or(1.0);
            let minimum = PhysicalSize::new(
                (640.0 * dpi).round() as u32 + next.left + next.right,
                (480.0 * dpi).round() as u32 + next.top + next.bottom,
            );
            // 先降低旧样式的最小尺寸，避免由大挂件切回小时被旧最小尺寸撑大面板。
            if main.set_min_size(Some(minimum)).is_ok() {
                *state.minimum.lock().ok()? = Some(minimum);
            }
            if let Err(error) = main.set_size(target) {
                *state.insets.lock().ok()? = old;
                tracing::error!("Resizing window shell failed: {error}");
                return None;
            }
            let _ = main.set_position(PhysicalPosition::new(
                outer.x + old.left as i32 - next.left as i32,
                outer.y + old.top as i32 - next.top as i32,
            ));
        }
        let dpi = main.scale_factor().unwrap_or(1.0);
        let minimum = PhysicalSize::new(
            (640.0 * dpi).round() as u32 + model.insets.left + model.insets.right,
            (480.0 * dpi).round() as u32 + model.insets.top + model.insets.bottom,
        );
        if *state.minimum.lock().ok()? != Some(minimum) && main.set_min_size(Some(minimum)).is_ok()
        {
            *state.minimum.lock().ok()? = Some(minimum);
        }
    }
    *state.input_insets.lock().ok()? = model.insets;
    if *state.emitted.lock().ok()? != Some(model) {
        let _ = main.emit("window-shell-layout", model);
        *state.emitted.lock().ok()? = Some(model);
    }
    Some(model)
}

pub fn sync(app: &AppHandle) {
    let _ = apply(app);
}

/// 仅记录可见面板的几何，防止每次启动/切换样式都累加透明留白。
pub fn record_bounds(app: &AppHandle) {
    let state = app.state::<DecorationState>();
    let Ok(_syncing) = state.syncing.try_lock() else {
        return;
    };
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if main.is_maximized().unwrap_or(true)
        || main.is_minimized().unwrap_or(true)
        || main.is_fullscreen().unwrap_or(true)
    {
        return;
    }
    let (Ok(position), Ok(size)) = (main.inner_position(), main.inner_size()) else {
        return;
    };
    if position.x <= -32000 || position.y <= -32000 {
        return;
    }
    let Ok(insets) = state.insets.lock() else {
        return;
    };
    let width = size.width.saturating_sub(insets.left + insets.right);
    let height = size.height.saturating_sub(insets.top + insets.bottom);
    let dpi = main.scale_factor().unwrap_or(1.0);
    if f64::from(width) < 640.0 * dpi || f64::from(height) < 480.0 * dpi {
        return;
    }
    app.state::<ConfigStore>().update_geometry(
        (
            (position.x + insets.left as i32) as f32,
            (position.y + insets.top as i32) as f32,
        ),
        (width as f32, height as f32),
    );
}

/// 截图工作线程等待前端隐藏角色并完成一帧；超时则临时隐藏整个主窗口，避免漏拍角色。
pub fn suspend(app: &AppHandle, suspended: bool) {
    let state = app.state::<DecorationState>();
    state.suspended.store(suspended, Ordering::SeqCst);
    if suspended {
        if !state.ready.load(Ordering::SeqCst) {
            return;
        }
        let id = state.capture_id.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(main) = app.get_webview_window("main") else {
            return;
        };
        if !main.is_visible().unwrap_or(false) || main.is_minimized().unwrap_or(true) {
            return;
        }
        // 不更改留白和面板位置，只发送角色隐藏状态。
        let hidden = current_layout(app, &main);
        let _ = main.emit("window-shell-layout", hidden);
        *state
            .emitted
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(hidden);
        let acknowledged = state
            .acknowledged
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let result = state.capture_ready.wait_timeout_while(
            acknowledged,
            std::time::Duration::from_millis(750),
            |ack| *ack != id,
        );
        if (result.is_err() || result.is_ok_and(|(ack, _)| *ack != id)) && main.hide().is_ok() {
            state.restore_main.store(true, Ordering::SeqCst);
        }
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Graphics::Dwm::DwmFlush();
        }
    } else {
        if state.restore_main.swap(false, Ordering::SeqCst) {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
            }
        }
        sync(app);
    }
}

/// 鼠标监视独立于 WebView 事件；鼠标处于透明留白或角色上时整窗穿透。
pub fn start_tracking(app: AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        use windows::Win32::{
            Foundation::{HWND, POINT, RECT},
            Graphics::Gdi::ScreenToClient,
            UI::WindowsAndMessaging::{GetClientRect, GetCursorPos, IsWindow},
        };
        let Some(main) = app.get_webview_window("main") else {
            return;
        };
        let Ok(handle) = main.hwnd() else { return };
        let raw = handle.0 as isize;
        let mut ignored = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(8));
            let hwnd = HWND(raw as *mut _);
            if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                break;
            }
            let state = app.state::<DecorationState>();
            if !state.ready.load(Ordering::SeqCst) {
                continue;
            }
            let mut cursor = POINT::default();
            let mut rect = RECT::default();
            if unsafe { GetCursorPos(&mut cursor) }.is_err()
                || unsafe { GetClientRect(hwnd, &mut rect) }.is_err()
                || !unsafe { ScreenToClient(hwnd, &mut cursor) }.as_bool()
            {
                continue;
            }
            let insets = *state
                .input_insets
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let ignore =
                !geometry::panel_contains(insets, rect.right, rect.bottom, cursor.x, cursor.y);
            if ignore != ignored && main.set_ignore_cursor_events(ignore).is_ok() {
                ignored = ignore;
            }
        }
    });
    #[cfg(not(windows))]
    let _ = app;
}

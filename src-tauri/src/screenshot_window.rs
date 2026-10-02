//! 启动预热与实际截图共用的隐藏截图 WebView 创建逻辑。
use crate::screenshot::{ScreenshotStore, WINDOW_LABEL};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub fn ensure_window(
    app: &AppHandle,
    bounds: Option<(i32, i32, u32, u32)>,
) -> tauri::Result<WebviewWindow> {
    // 预热与热键可能同时到达，只允许一个 worker 创建窗口。
    let store = app.state::<ScreenshotStore>();
    let _creation = store.window_creation.lock().unwrap();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if let Some((x, y, width, height)) = bounds {
            window.set_position(PhysicalPosition::new(x, y))?;
            window.set_size(PhysicalSize::new(width, height))?;
        }
        return Ok(window);
    }
    let (x, y, width, height) = bounds.unwrap_or((0, 0, 64, 64));
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0)
        .max(0.5);
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("screenshot.html".into()))
        .title("screenshot")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .position(x as f64 / scale, y as f64 / scale)
        .inner_size(width as f64 / scale, height as f64 / scale)
        .visible(false)
        .focused(false)
        .build()
}

#[tauri::command]
pub async fn prepare_screenshot_window(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        ensure_window(&app, None).map_err(|error| error.to_string())?;
        tracing::info!("截图窗口后台准备: {}ms", started.elapsed().as_millis());
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

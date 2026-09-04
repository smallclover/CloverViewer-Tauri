//! 截图覆盖窗 —— 移植自 CloverViewer feature/screenshot/capture 的截屏 + 窗口逻辑。
//!
//! 与 egui 版的关键差异：egui 版复用主窗口 viewport 切换透明态；Tauri 版改为**独立截图窗口**
//! （独立 HWND，规避与主窗口共享 HWND 导致的样式/状态泄漏——Xiangxu 项目已验证的教训）。
//!
//! 性能策略：
//! - 物理像素直接传给 `position()`/`inner_size()`（Tauri 2 Windows 上这两 API 都用物理像素，
//!   旧版除以 scale_factor 会让窗口在非 100% DPI 屏上错位+尺寸偏小 → 截图坐标与实际不吻合）。
//! - 复用截图窗口（hide 代替 close），省去每次重建 WebView2 的开销（首屏 200-500ms）。
//! - 截屏完成 → 写 store → `emit("screenshot-refresh")`，前端监听后清状态+重载截图。
//! - `capturing` 互斥锁避免重叠 Alt+S。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Serialize)]
pub struct ScreenData {
    /// 该屏在虚拟桌面中的物理坐标（左上角）
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// 截屏 PNG data URL
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScreenshotData {
    /// 虚拟桌面包围盒（物理像素）
    pub min_x: i32,
    pub min_y: i32,
    pub total_width: u32,
    pub total_height: u32,
    pub screens: Vec<ScreenData>,
}

pub struct ScreenshotStore {
    data: Mutex<Option<ScreenshotData>>,
    capturing: Mutex<bool>,
}

impl ScreenshotStore {
    pub fn new() -> Self {
        Self {
            data: Mutex::new(None),
            capturing: Mutex::new(false),
        }
    }
}

/// 截图窗口前端拉取截屏数据
#[tauri::command]
pub fn get_screenshot_data(store: State<'_, ScreenshotStore>) -> Option<ScreenshotData> {
    store.data.lock().unwrap().clone()
}

/// 关闭截图窗口（前端 Esc 时调用）—— 仅隐藏窗口（不销毁），保留供下次复用。
#[tauri::command]
pub fn close_screenshot(app: AppHandle) {
    if let Some(w) = app.get_webview_window("screenshot") {
        let _ = w.hide();
    }
}

/// 复制纯文本到剪贴板（放大镜取色 Ctrl+C 用）
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

/// 前端导出完成后的收尾请求：PNG 已由前端 Canvas 合成（裁剪 + 标注），
/// Rust 侧只负责「落盘」或「写剪贴板」，然后隐藏截图窗口。
#[derive(Debug, Deserialize)]
pub struct FinishRequest {
    /// "save" | "clipboard"
    pub action: String,
    /// 前端 `canvas.toBlob` 导出的 PNG（base64，可带 data: 前缀）
    pub png: String,
}

#[tauri::command]
pub fn finish_screenshot(app: AppHandle, req: FinishRequest) -> Result<(), String> {
    let b64 = req
        .png
        .trim_start_matches("data:image/png;base64,");
    let png = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;

    match req.action.as_str() {
        "save" => {
            let desktop = dirs::desktop_dir().ok_or("未找到桌面目录")?;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let path = desktop.join(format!("screenshot_{ts}.png"));
            std::fs::write(&path, &png).map_err(|e| e.to_string())?;
            tracing::info!("截图已保存: {}", path.display());
        }
        "clipboard" => {
            let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?
                .to_rgba8();
            let width = img.width() as usize;
            let height = img.height() as usize;
            let bytes = img.into_raw();
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard
                .set_image(arboard::ImageData {
                    width,
                    height,
                    bytes: std::borrow::Cow::Owned(bytes),
                })
                .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("未知动作: {other}")),
    }

    if let Some(w) = app.get_webview_window("screenshot") {
        let _ = w.hide();
    }
    Ok(())
}

/// 进入截图模式：截屏 + 复用/创建截图窗口（由全局热键触发）
pub fn start_screenshot(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // 防并发：若上一次截屏尚未结束则丢弃本次
        let store = app.state::<ScreenshotStore>();
        {
            let mut cap = store.capturing.lock().unwrap();
            if *cap {
                return;
            }
            *cap = true;
        }

        let data = match capture_all() {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("截屏失败: {e}");
                let store = app.state::<ScreenshotStore>();
                *store.capturing.lock().unwrap() = false;
                return;
            }
        };

        // 写 store
        {
            let store = app.state::<ScreenshotStore>();
            *store.data.lock().unwrap() = Some(data.clone());
        }

        // 获取或创建截图窗口（缓存复用，省掉首次之后的窗口创建开销）
        let win = if let Some(w) = app.get_webview_window("screenshot") {
            w
        } else {
            match WebviewWindowBuilder::new(
                &app,
                "screenshot",
                WebviewUrl::App("screenshot.html".into()),
            )
            .title("screenshot")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false) // 先隐藏，定位后再显示，避免初始闪动
            .build()
            {
                Ok(w) => w,
                Err(e) => {
                    tracing::error!("创建截图窗口失败: {e}");
                    let store = app.state::<ScreenshotStore>();
                    *store.capturing.lock().unwrap() = false;
                    return;
                }
            }
        };

        // 物理像素定位（Windows 上 Tauri 2 的 set_position/set_size 默认就是物理像素）
        let _ = win.set_position(PhysicalPosition::new(data.min_x, data.min_y));
        let _ = win.set_size(PhysicalSize::new(data.total_width, data.total_height));
        let _ = win.show();
        let _ = win.set_focus();

        // 通知前端刷新：复用窗口下 main() 不会再执行，需要前端监听此事件重置状态
        if let Err(e) = win.emit("screenshot-refresh", ()) {
            tracing::warn!("emit screenshot-refresh 失败: {e}");
        }

        let store = app.state::<ScreenshotStore>();
        *store.capturing.lock().unwrap() = false;
    });
}

fn capture_all() -> Result<ScreenshotData, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;

    let mut screens = Vec::new();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);

    for m in monitors {
        let img = m.capture_image().map_err(|e| e.to_string())?;
        let width = img.width();
        let height = img.height();
        let x = m.x().unwrap_or(0);
        let y = m.y().unwrap_or(0);
        if width == 0 || height == 0 {
            continue;
        }

        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);

        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + width as i32);
        max_y = max_y.max(y + height as i32);

        screens.push(ScreenData {
            x,
            y,
            width,
            height,
            data_url: format!("data:image/png;base64,{b64}"),
        });
    }

    if screens.is_empty() {
        return Err("未检测到显示器".to_string());
    }

    Ok(ScreenshotData {
        min_x,
        min_y,
        total_width: (max_x - min_x).max(1) as u32,
        total_height: (max_y - min_y).max(1) as u32,
        screens,
    })
}
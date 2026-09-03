//! 截图覆盖窗 PoC —— 移植自 CloverViewer feature/screenshot/capture 的截屏 + 窗口逻辑。
//!
//! 与 egui 版的关键差异：egui 版复用主窗口 viewport 切换透明态；Tauri 版改为**独立截图窗口**
//! （独立 HWND，规避与主窗口共享 HWND 导致的样式/状态泄漏——Xiangxu 项目已验证的教训）。
//!
//! PoC 范围：xcap 逐屏截取 → 创建透明无边框 AlwaysOnTop 全屏窗（覆盖多屏虚拟桌面）→
//! 前端拼接显示 + Canvas 选区 + Esc 关闭。若透明/多屏坐标验证通过，再移植完整标注。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

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
}

impl ScreenshotStore {
    pub fn new() -> Self {
        Self {
            data: Mutex::new(None),
        }
    }
}

/// 截图窗口前端拉取截屏数据
#[tauri::command]
pub fn get_screenshot_data(store: State<'_, ScreenshotStore>) -> Option<ScreenshotData> {
    store.data.lock().unwrap().clone()
}

/// 关闭截图窗口（前端 Esc 时调用，避免依赖 window close 权限）
#[tauri::command]
pub fn close_screenshot(app: AppHandle) {
    if let Some(w) = app.get_webview_window("screenshot") {
        let _ = w.close();
    }
}

/// 复制纯文本到剪贴板（放大镜取色 Ctrl+C 用）
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

/// 前端导出完成后的收尾请求：PNG 已由前端 Canvas 合成（裁剪 + 标注），
/// Rust 侧只负责「落盘」或「写剪贴板」，然后关闭截图窗口。
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
        let _ = w.close();
    }
    Ok(())
}

/// 进入截图模式：后台截屏 + 创建透明全屏窗（由全局热键触发）
pub fn start_screenshot(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // 先关闭可能残留的旧截图窗口
        if let Some(old) = app.get_webview_window("screenshot") {
            let _ = old.close();
        }

        let data = match capture_all() {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("截屏失败: {e}");
                return;
            }
        };

        {
            let store = app.state::<ScreenshotStore>();
            *store.data.lock().unwrap() = Some(data.clone());
        }

        // 主窗口 DPI 缩放因子：builder 的 position/inner_size 用逻辑像素，
        // 需将 xcap 的物理像素换算（多屏 per-monitor DPI 差异 PoC 暂忽略）
        let scale = app
            .get_webview_window("main")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0)
            .max(0.1);

        let win = WebviewWindowBuilder::new(
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
        .inner_size(
            data.total_width as f64 / scale,
            data.total_height as f64 / scale,
        )
        .position(data.min_x as f64 / scale, data.min_y as f64 / scale)
        .build();

        match win {
            Ok(w) => {
                let _ = w.set_focus();
            }
            Err(e) => tracing::error!("创建截图窗口失败: {e}"),
        }
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

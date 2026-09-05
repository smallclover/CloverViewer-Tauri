//! 截图覆盖窗 —— 移植自 CloverViewer feature/screenshot/capture 的截屏 + 窗口逻辑。
//!
//! 与 egui 版的关键差异：egui 版复用主窗口 viewport 切换透明态；Tauri 版改为**独立截图窗口**
//! （独立 HWND，规避与主窗口共享 HWND 导致的样式/状态泄漏——Xiangxu 项目已验证的教训）。
//!
//! 性能策略：
//! - **改用 builder API 在 build 阶段一次性设置 position + inner_size**（logical 像素）。
//!   早期版本用 `set_position(PhysicalPosition)` 在 show 后再移动，wry Windows 后端有时不
//!   按 physical 单位消费、外加 OS relayout race，窗口外框偏离 + 内部 viewport 不对齐。
//!   builder 上 `position`/`inner_size` 是 logical，wry 内部按窗口所在 monitor 的 scale
//!   自动换算成 raw pixel 调 SetWindowPos，定位最稳。
//! - 每次 Alt+S 销毁旧窗口重新 build。首次 WebView2 启动 200-500ms 不可避免，但彻底消除
//!   位置 race 与 stash 缓存带来的 stale-state bug。
//! - 截屏完成 → 写 store → `emit("screenshot-refresh")`，前端监听后清状态 + 重载截图。
//! - `capturing` 互斥锁避免重叠 Alt+S。
//!
//! 坐标约定：
//! - xcap 的 `Monitor::x()/y()/width()/height()` 在 per-monitor DPI aware 进程下是
//!   **虚拟桌面物理像素**（raw PIXELS），与 `Cursor::position()` 同坐标系统。
//! - Tauri 2 builder 的 `.position(x, y)` 是 logical 像素；换算：logical = physical / scale。

use base64::Engine;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use serde::{Deserialize, Serialize};
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
    /// 每个 monitor 的原始 xcap 元数据（物理像素、scale factor），
    /// 用于诊断多屏混合 DPI / 跨屏坐标偏移问题。
    pub monitor_info: Vec<MonitorInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub img_width: u32,
    pub img_height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
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
        // 先让前端清掉画面（移除 body.ready），避免下次 show 时闪旧截图
        let _ = w.emit("screenshot-clear", ());
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
        // 同上：隐藏前清画面，避免下次复用时闪旧截图
        let _ = w.emit("screenshot-clear", ());
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

        // 窗口缓存复用：首次用 builder 创建（一次到位），之后 hide 留存、
        // Alt+S 时 set_position/set_size（物理像素）+ show。
        // 位置 bug 的真正根因是前端 canvas CSS 不拉伸（已修），set_position(PhysicalPosition)
        // 本身行为正常 —— 之前误删缓存导致每次 cold start WebView2 1-3s。
        let win = if let Some(w) = app.get_webview_window("screenshot") {
            let _ = w.set_position(PhysicalPosition::new(data.min_x, data.min_y));
            let _ = w.set_size(PhysicalSize::new(data.total_width, data.total_height));
            w
        } else {
            // 取主屏 scale —— builder 上 position/inner_size 是 logical，
            // wry 内部按窗口所在 monitor 的 scale 反算 physical → SetWindowPos。
            let scale = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| m.scale_factor())
                .unwrap_or(1.0)
                .max(0.5);
            let s = scale as f64;

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
            .position(data.min_x as f64 / s, data.min_y as f64 / s)
            .inner_size(data.total_width as f64 / s, data.total_height as f64 / s)
            .visible(true)
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

        let _ = win.show();
        let _ = win.set_focus();

        // 通知前端刷新：复用窗口下 main() 不会重跑，由事件触发 loadScreenshot。
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
    let mut monitor_info = Vec::new();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);

    for m in monitors {
        let img = m.capture_image().map_err(|e| e.to_string())?;
        let width = img.width();
        let height = img.height();
        let x = m.x().unwrap_or(0);
        let y = m.y().unwrap_or(0);
        let m_w = m.width().unwrap_or(0);
        let m_h = m.height().unwrap_or(0);
        let scale = m.scale_factor().unwrap_or(1.0);
        let is_primary = m.is_primary().unwrap_or(false);
        if width == 0 || height == 0 {
            continue;
        }

        // PNG 用 Fast 压缩 + NoFilter：默认设置（Best/Adaptive）在 4K 屏上
        // 单张编码要几百 ms，是 Alt+S 延迟的大头之一。
        let mut png = Vec::new();
        PngEncoder::new_with_quality(
            &mut png,
            CompressionType::Fast,
            FilterType::NoFilter,
        )
        .write_image(img.as_raw(), width, height, ExtendedColorType::Rgba8)
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
        monitor_info.push(MonitorInfo {
            x,
            y,
            width: m_w,
            height: m_h,
            img_width: width,
            img_height: height,
            scale_factor: scale,
            is_primary,
        });
    }

    if screens.is_empty() {
        return Err("未检测到显示器".to_string());
    }

    // 诊断日志（dev 模式必看）：每个 monitor 的物理像素坐标 + scale factor + image 尺寸
    // 用于排查多屏混合 DPI / 跨屏截图偏移 / 跨屏放大镜采样错位等问题。
    eprintln!("[screenshot] monitors (raw, all values physical px):");
    for (i, mi) in monitor_info.iter().enumerate() {
        eprintln!(
            "  [{}] x={} y={} m.w={} m.h={} img={}x{} scale={} primary={}",
            i, mi.x, mi.y, mi.width, mi.height, mi.img_width, mi.img_height, mi.scale_factor, mi.is_primary
        );
    }
    eprintln!(
        "[screenshot] virtual desktop: minX={} minY={} totalW={} totalH={}",
        min_x, min_y, max_x - min_x, max_y - min_y
    );

    Ok(ScreenshotData {
        min_x,
        min_y,
        total_width: (max_x - min_x).max(1) as u32,
        total_height: (max_y - min_y).max(1) as u32,
        screens,
        monitor_info,
    })
}
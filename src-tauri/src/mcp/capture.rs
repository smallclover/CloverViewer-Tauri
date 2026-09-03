//! MCP 截图捕获 —— 从 CloverViewer (egui 版) 的 mcp/capture.rs 原样移植。
//!
//! 复用与截图功能相同的 xcap 依赖，独立于前端 UI 运行（MCP stdio/HTTP 模式下无窗口）。

use image::RgbaImage;
use xcap::{Monitor, Window};

/// 显示器信息（独立于 egui）
#[allow(dead_code)]
pub struct MonitorInfo {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 捕获的显示器截图
pub struct CapturedMonitor {
    pub image: RgbaImage,
    #[allow(dead_code)]
    pub info: MonitorInfo,
}

/// 捕获所有显示器的截图
pub fn capture_all_monitors() -> Result<Vec<CapturedMonitor>, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    let mut captures = Vec::new();

    for monitor in monitors {
        let width = monitor.width().unwrap_or(0);
        if width == 0 {
            continue;
        }

        let image = monitor
            .capture_image()
            .map_err(|e| format!("Failed to capture monitor: {e}"))?;

        let info = MonitorInfo {
            name: monitor.name().unwrap_or_default(),
            x: monitor.x().unwrap_or(0),
            y: monitor.y().unwrap_or(0),
            width,
            height: monitor.height().unwrap_or(0),
        };

        captures.push(CapturedMonitor { image, info });
    }

    Ok(captures)
}

/// 捕获指定索引的显示器截图
pub fn capture_monitor(index: usize) -> Result<CapturedMonitor, String> {
    let captures = capture_all_monitors()?;
    captures
        .into_iter()
        .nth(index)
        .ok_or_else(|| format!("Monitor index {index} out of range"))
}

/// 捕获当前活动窗口的截图
pub fn capture_active_window() -> Result<CapturedMonitor, String> {
    let windows = Window::all().map_err(|e| format!("Failed to enumerate windows: {e}"))?;

    let focused = windows
        .into_iter()
        .find(|w| w.is_focused().unwrap_or(false))
        .ok_or_else(|| "No focused window found".to_string())?;

    let width = focused.width().unwrap_or(0);
    let height = focused.height().unwrap_or(0);
    let title = focused.title().unwrap_or_default();

    let image = focused
        .capture_image()
        .map_err(|e| format!("Failed to capture window: {e}"))?;

    let info = MonitorInfo {
        name: title,
        x: focused.x().unwrap_or(0),
        y: focused.y().unwrap_or(0),
        width,
        height,
    };

    Ok(CapturedMonitor { image, info })
}

//! Independent screen-capture primitives used by the MCP server.

use image::RgbaImage;
use serde::Serialize;
use xcap::{Monitor, Window};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: u32,
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    pub scale_factor: Option<f32>,
}

pub struct CapturedImage {
    pub image: RgbaImage,
    pub source: String,
    pub x: i32,
    pub y: i32,
}

pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    Monitor::all()
        .map_err(|e| format!("Failed to enumerate monitors: {e}"))?
        .into_iter()
        .enumerate()
        .map(|(index, monitor)| {
            Ok(MonitorInfo {
                id: monitor
                    .id()
                    .map_err(|e| format!("Failed to read monitor id: {e}"))?,
                index,
                name: monitor.name().unwrap_or_default(),
                x: monitor.x().unwrap_or(0),
                y: monitor.y().unwrap_or(0),
                width: monitor.width().unwrap_or(0),
                height: monitor.height().unwrap_or(0),
                primary: monitor.is_primary().unwrap_or(false),
                scale_factor: monitor.scale_factor().ok(),
            })
        })
        .collect()
}

pub fn capture_all_monitors() -> Result<Vec<CapturedImage>, String> {
    Monitor::all()
        .map_err(|e| format!("Failed to enumerate monitors: {e}"))?
        .into_iter()
        .enumerate()
        .filter_map(|(index, monitor)| {
            (monitor.width().unwrap_or(0) > 0).then_some((index, monitor))
        })
        .map(|(index, monitor)| capture_monitor_inner(monitor, format!("monitor:{index}")))
        .collect()
}

pub fn capture_monitor(index: usize) -> Result<CapturedImage, String> {
    let monitor = Monitor::all()
        .map_err(|e| format!("Failed to enumerate monitors: {e}"))?
        .into_iter()
        .nth(index)
        .ok_or_else(|| format!("Monitor index {index} out of range"))?;
    capture_monitor_inner(monitor, format!("monitor:{index}"))
}

pub fn capture_monitor_by_id(id: u32) -> Result<CapturedImage, String> {
    let monitor = Monitor::all()
        .map_err(|e| format!("Failed to enumerate monitors: {e}"))?
        .into_iter()
        .find(|monitor| monitor.id().ok() == Some(id))
        .ok_or_else(|| format!("Monitor id {id} was not found"))?;
    capture_monitor_inner(monitor, format!("monitor_id:{id}"))
}

pub fn capture_region(x: i32, y: i32, width: u32, height: u32) -> Result<CapturedImage, String> {
    if width == 0 || height == 0 {
        return Err("Region width and height must be greater than zero".to_string());
    }
    let right = x
        .checked_add_unsigned(width)
        .ok_or("Region x coordinate overflows")?;
    let bottom = y
        .checked_add_unsigned(height)
        .ok_or("Region y coordinate overflows")?;
    let monitor = Monitor::all()
        .map_err(|e| format!("Failed to enumerate monitors: {e}"))?
        .into_iter()
        .find(|monitor| {
            let mx = monitor.x().unwrap_or(0);
            let my = monitor.y().unwrap_or(0);
            let mr = mx.saturating_add_unsigned(monitor.width().unwrap_or(0));
            let mb = my.saturating_add_unsigned(monitor.height().unwrap_or(0));
            x >= mx && y >= my && right <= mr && bottom <= mb
        })
        .ok_or_else(|| "Region must be fully contained by one monitor".to_string())?;
    let mx = monitor.x().unwrap_or(0);
    let my = monitor.y().unwrap_or(0);
    let image = monitor
        .capture_region((x - mx) as u32, (y - my) as u32, width, height)
        .map_err(|e| format!("Failed to capture region: {e}"))?;
    Ok(CapturedImage {
        image,
        source: "region".to_string(),
        x,
        y,
    })
}

pub fn capture_active_window() -> Result<CapturedImage, String> {
    let focused = Window::all()
        .map_err(|e| format!("Failed to enumerate windows: {e}"))?
        .into_iter()
        .find(|window| window.is_focused().unwrap_or(false))
        .ok_or_else(|| "No focused window found".to_string())?;
    let x = focused.x().unwrap_or(0);
    let y = focused.y().unwrap_or(0);
    let image = focused
        .capture_image()
        .map_err(|e| format!("Failed to capture focused window: {e}"))?;
    Ok(CapturedImage {
        image,
        source: "active_window".to_string(),
        x,
        y,
    })
}

fn capture_monitor_inner(monitor: Monitor, source: String) -> Result<CapturedImage, String> {
    let x = monitor.x().unwrap_or(0);
    let y = monitor.y().unwrap_or(0);
    let image = monitor
        .capture_image()
        .map_err(|e| format!("Failed to capture monitor: {e}"))?;
    Ok(CapturedImage {
        image,
        source,
        x,
        y,
    })
}

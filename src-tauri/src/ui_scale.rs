//! 按显示器逻辑分辨率自动调整界面密度（WebView 页面缩放）。
//!
//! 背景：前端是整套固定 px 尺寸，同一个 13px 字号占屏幕的比例取决于**逻辑分辨率**
//! （物理像素 / scale_factor）。1080p@100% 只有 1920x1080 逻辑像素，同一套界面在
//! 那里就显得比 2K/4K 上「大一号、发挤」。
//!
//! 这里按窗口所在显示器的逻辑分辨率反推一个缩放比，用 `WebviewWindow::set_zoom`
//! 写进 WebView。选它而不是 CSS `transform: scale()`：页面缩放是浏览器缩放语义，
//! 会重排布局（同屏看到更多内容）并按设备像素重新栅格化，而不是把整个界面拉伸成
//! 模糊的大图。
//!
//! 只缩小、不放大：2K（2560x1440）及以上逻辑分辨率维持 1.0，这些屏幕用户已确认
//! 观感正常；下限 0.8（1080p 一档），再小文字就难认了。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::WebviewWindow;

/// 基准逻辑分辨率（2K）：达到这个尺寸即视为界面密度正常。
const REFERENCE_WIDTH: f64 = 2560.0;
const REFERENCE_HEIGHT: f64 = 1440.0;

/// 缩放比区间：只缩小不放大。
const MIN_ZOOM: f64 = 0.8;
const MAX_ZOOM: f64 = 1.0;
/// 取值步进：避免出现 0.83 这类不好解释、也不好复现的值。
const STEP: f64 = 0.05;

/// 每个窗口最近一次写入的缩放比。
///
/// 窗口拖动时 `Moved` 会高频触发，值没变就不该再碰 WebView（否则每次移动都可能
/// 触发一次重排）。
static APPLIED: LazyLock<Mutex<HashMap<String, f64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_applied() -> std::sync::MutexGuard<'static, HashMap<String, f64>> {
    // 锁中毒只可能来自其它线程 panic；缩放表本身没有不变式，恢复即可。
    APPLIED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 由逻辑分辨率算出界面缩放比。纯函数，便于单测。
///
/// 宽高各算一次比例取较小者：屏幕越「矮」（如 2560x1080 带鱼屏）界面越该缩，
/// 否则一屏塞不下几行内容。
pub fn zoom_for_logical_size(width: f64, height: f64) -> f64 {
    if width.is_nan() || height.is_nan() || width <= 0.0 || height <= 0.0 {
        return MAX_ZOOM;
    }
    let ratio = (width / REFERENCE_WIDTH).min(height / REFERENCE_HEIGHT);
    let stepped = (ratio / STEP).round() * STEP;
    stepped.clamp(MIN_ZOOM, MAX_ZOOM)
}

/// 窗口所在显示器的逻辑分辨率；拿不到时退回主屏，再拿不到就返回 None。
fn logical_size(window: &WebviewWindow) -> Option<(f64, f64)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor().max(0.5);
    Some((
        monitor.size().width as f64 / scale,
        monitor.size().height as f64 / scale,
    ))
}

/// 按窗口当前所在屏幕应用界面缩放。
///
/// 可以随意重复调用：缩放比和上次相同时直接返回，不碰 WebView。
pub fn apply(window: &WebviewWindow) {
    let Some((width, height)) = logical_size(window) else {
        return;
    };
    let zoom = zoom_for_logical_size(width, height);
    let label = window.label().to_string();

    if lock_applied().get(&label) == Some(&zoom) {
        return;
    }

    match window.set_zoom(zoom) {
        Ok(()) => {
            tracing::info!("界面缩放 {zoom:.2}（逻辑分辨率 {width:.0}x{height:.0}）");
            lock_applied().insert(label, zoom);
        }
        Err(error) => tracing::warn!("应用界面缩放 {zoom:.2} 失败: {error}"),
    }
}

/// 忘掉某个窗口已应用的缩放比。
///
/// 两种场景必须调用：窗口销毁后重建（新 WebView 是 1.0，不重设就会跳过），
/// 以及页面（重新）加载后（WebView2 的缩放按站点记忆，加载完可能已经回到 1.0）。
pub fn forget(label: &str) {
    lock_applied().remove(label);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_two_k_and_above_untouched() {
        assert_eq!(zoom_for_logical_size(2560.0, 1440.0), 1.0);
        assert_eq!(zoom_for_logical_size(3840.0, 2160.0), 1.0);
        assert_eq!(zoom_for_logical_size(2560.0, 1600.0), 1.0);
    }

    #[test]
    fn shrinks_1080p_by_one_step() {
        assert_eq!(zoom_for_logical_size(1920.0, 1080.0), 0.8);
        // 1366x768 这类小屏不再继续缩，0.8 是可读性下限。
        assert_eq!(zoom_for_logical_size(1366.0, 768.0), 0.8);
        assert_eq!(zoom_for_logical_size(1280.0, 720.0), 0.8);
    }

    #[test]
    fn interpolates_between_bounds() {
        assert_eq!(zoom_for_logical_size(2048.0, 1152.0), 0.8);
        assert_eq!(zoom_for_logical_size(2304.0, 1296.0), 0.9);
    }

    #[test]
    fn short_screens_follow_the_weaker_axis() {
        // 2560x1080 带鱼屏：宽度够 2K，但高度只有 1080p。
        assert_eq!(zoom_for_logical_size(2560.0, 1080.0), 0.8);
    }

    #[test]
    fn unknown_size_falls_back_to_no_scaling() {
        assert_eq!(zoom_for_logical_size(0.0, 0.0), 1.0);
        assert_eq!(zoom_for_logical_size(f64::NAN, 1080.0), 1.0);
    }
}

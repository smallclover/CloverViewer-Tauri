//! 主界面和截图界面使用配置中的显示倍率，默认 100%。
//!
//! WebView 页面缩放会重新排版并按设备像素绘制文字；不再按屏幕分辨率自动缩小。
//! Windows 的显示缩放继续由 WebView 自己处理，图片和截图仍使用原始物理像素。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::config::{normalize_ui_scale, ConfigStore};

/// 只缓存已成功应用的倍率，避免窗口移动时反复重排。
static APPLIED: LazyLock<Mutex<HashMap<String, u16>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_applied() -> std::sync::MutexGuard<'static, HashMap<String, u16>> {
    APPLIED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn zoom_for_scale(scale: u16) -> f64 {
    f64::from(normalize_ui_scale(scale)) / 100.0
}

/// 首次创建、截图复用、页面加载和换屏时恢复已保存的倍率。
pub fn apply(window: &WebviewWindow) {
    let scale = window
        .app_handle()
        .try_state::<ConfigStore>()
        .map(|store| normalize_ui_scale(store.snapshot().ui_scale))
        .unwrap_or(100);
    let label = window.label().to_string();
    if lock_applied().get(&label) == Some(&scale) {
        return;
    }
    let zoom = zoom_for_scale(scale);
    match window.set_zoom(zoom) {
        Ok(()) => {
            tracing::info!("界面缩放 {scale}%");
            lock_applied().insert(label, scale);
        }
        Err(error) => tracing::warn!("应用界面缩放 {scale}% 失败: {error}"),
    }
}

/// 设置变更后立即同步现有主窗口和截图窗口（包含预建的隐藏窗口）。
pub fn apply_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if crate::uses_ui_scale(&label) {
            apply(&window);
        }
    }
}

/// 页面重载或窗口销毁后必须重新应用，WebView2 可能已将倍率恢复到 1.0。
pub fn forget_applied(label: &str) {
    lock_applied().remove(label);
}

pub fn forget(label: &str) {
    forget_applied(label);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_each_supported_percentage_without_resolution_scaling() {
        for (scale, expected) in [(100, 1.0), (110, 1.1), (125, 1.25), (150, 1.5)] {
            assert_eq!(zoom_for_scale(scale), expected);
        }
    }

    #[test]
    fn invalid_preferences_restore_readable_default() {
        for scale in [0, 80, 99, 101, 200, u16::MAX] {
            assert_eq!(zoom_for_scale(scale), 1.0);
        }
    }
}

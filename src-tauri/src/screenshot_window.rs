//! 启动预热与实际截图共用的隐藏截图 WebView 创建逻辑。
use crate::screenshot::{ScreenshotStore, WINDOW_LABEL};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

type DesktopBounds = (i32, i32, u32, u32);

/// 合并物理屏幕范围，保留副屏位于主屏左侧/上方时的负坐标。
fn desktop_bounds(screens: impl IntoIterator<Item = DesktopBounds>) -> Option<DesktopBounds> {
    let mut extent: Option<(i64, i64, i64, i64)> = None;
    for (x, y, width, height) in screens {
        if width == 0 || height == 0 {
            continue;
        }
        let (left, top) = (i64::from(x), i64::from(y));
        let (right, bottom) = (left + i64::from(width), top + i64::from(height));
        extent = Some(match extent {
            Some((l, t, r, b)) => (l.min(left), t.min(top), r.max(right), b.max(bottom)),
            None => (left, top, right, bottom),
        });
    }
    let (left, top, right, bottom) = extent?;
    Some((
        left.try_into().ok()?,
        top.try_into().ok()?,
        (right - left).try_into().ok()?,
        (bottom - top).try_into().ok()?,
    ))
}

fn warmup_bounds(app: &AppHandle) -> Option<DesktopBounds> {
    let monitors = app.available_monitors().ok()?;
    desktop_bounds(monitors.iter().map(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        (position.x, position.y, size.width, size.height)
    }))
}

/// set_position 使用外框坐标；根据实际内外框偏移一次性定位内容区域。
/// 内容已对齐时不再先移回原点再补偿，避免复用时产生多余的原生移动事件。
fn corrected_outer_position(
    outer: PhysicalPosition<i32>,
    inner: PhysicalPosition<i32>,
    target: PhysicalPosition<i32>,
) -> Option<PhysicalPosition<i32>> {
    if inner == target {
        return None;
    }
    let coordinate = |outer: i32, inner: i32, target: i32| {
        (i64::from(outer) + i64::from(target) - i64::from(inner))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
    };
    Some(PhysicalPosition::new(
        coordinate(outer.x, inner.x, target.x),
        coordinate(outer.y, inner.y, target.y),
    ))
}

fn align_content(
    window: &WebviewWindow,
    (x, y, width, height): DesktopBounds,
) -> tauri::Result<bool> {
    let target = PhysicalPosition::new(x, y);
    if let Some(position) =
        corrected_outer_position(window.outer_position()?, window.inner_position()?, target)
    {
        window.set_position(position)?;
        // 移动可能触发 DPI 调整；等下一次同步读取实际 HWND，再决定尺寸。
        return Ok(false);
    }
    let size = PhysicalSize::new(width, height);
    if window.inner_size()? != size {
        window.set_size(size)?;
        // Windows 的 SetWindowPos 是异步的，不能用旧 HWND 尺寸设置子视图比例。
        return Ok(false);
    }
    // HWND 与 WebView2 的尺寸更新不是同一件事：隐藏窗口复用时，子视图可能保留旧范围。
    let webview: &tauri::Webview = window.as_ref();
    // 即使子 HWND 范围正确，WebView2 controller 也可能仍用旧范围。
    // 父窗已对齐后重写 bounds，同时恢复 Tauri 的子视图自动缩放比例为 1。
    webview.set_bounds(tauri::Rect {
        position: PhysicalPosition::new(0, 0).into(),
        size: size.into(),
    })?;
    content_matches(window, (x, y, width, height))
}

pub(crate) fn content_matches(
    window: &WebviewWindow,
    (x, y, width, height): DesktopBounds,
) -> tauri::Result<bool> {
    let size = PhysicalSize::new(width, height);
    let webview: &tauri::Webview = window.as_ref();
    let actual = webview.bounds()?;
    let scale = window.scale_factor()?;
    Ok(window.inner_position()? == PhysicalPosition::new(x, y)
        && window.inner_size()? == size
        && actual.size.to_physical::<u32>(scale) == size
        && actual.position.to_physical::<i32>(scale) == PhysicalPosition::new(0, 0))
}

#[tauri::command]
pub fn sync_screenshot_window(app: AppHandle, capture_id: u64) -> Result<Option<bool>, String> {
    let store = app.state::<ScreenshotStore>();
    let Some(bounds) = store.capture_bounds(capture_id) else {
        return Ok(None);
    };
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Ok(None);
    };
    align_content(&window, bounds)
        .map(Some)
        .map_err(|error| error.to_string())
}

pub fn ensure_window(
    app: &AppHandle,
    bounds: Option<DesktopBounds>,
) -> tauri::Result<WebviewWindow> {
    // 预热与热键可能同时到达，只允许一个 worker 创建窗口。
    let store = app.state::<ScreenshotStore>();
    let _creation = store.window_creation.lock().unwrap();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if let Some(bounds) = bounds {
            align_content(&window, bounds)?;
        }
        return Ok(window);
    }
    // 预热就使用完整桌面尺寸，避免第一次截图才从 64×64 扩展 WebView。
    // 显示器查询失败时保留小窗回退，实际截图仍以捕获元数据校正。
    let (x, y, width, height) = bounds
        .or_else(|| warmup_bounds(app))
        .unwrap_or((0, 0, 64, 64));
    let scale = app
        .monitor_from_point(f64::from(x), f64::from(y))
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0)
        .max(0.5);
    let window =
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
            .build()?;
    #[cfg(target_os = "windows")]
    disable_window_transitions(&window);
    align_content(&window, (x, y, width, height))?;
    // 保存的倍率也在隐藏阶段应用；第一次按热键不再触发额外排版。
    crate::ui_scale::apply(&window);
    Ok(window)
}

/// 覆盖窗内是一张完整桌面，系统显隐动画会使背景看起来随窗口一起缩放。
/// 只关闭本截图 HWND 的 DWM 过渡，保持显隐切换直接完成。
#[cfg(target_os = "windows")]
fn disable_window_transitions(window: &WebviewWindow) {
    use windows::core::BOOL;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let disabled = BOOL(1);
    // Tauri 与本项目使用不同版本的 windows crate，以原始句柄重建类型。
    // 指针指向调用期间有效的 Win32 BOOL，长度与其实际大小一致。
    let result = unsafe {
        DwmSetWindowAttribute(
            HWND(hwnd.0),
            DWMWA_TRANSITIONS_FORCEDISABLED,
            (&disabled as *const BOOL).cast(),
            std::mem::size_of::<BOOL>() as u32,
        )
    };
    if let Err(error) = result {
        tracing::warn!("禁用截图窗口过渡动画失败: {error}");
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warmup_covers_physical_desktop_with_negative_and_staggered_monitors() {
        assert_eq!(
            desktop_bounds([
                (-2560, 200, 2560, 1440),
                (0, 0, 3840, 2160),
                (800, -1080, 1920, 1080)
            ]),
            Some((-2560, -1080, 6400, 3240))
        );
    }

    #[test]
    fn empty_monitors_do_not_create_a_zero_sized_warmup_window() {
        assert_eq!(desktop_bounds([]), None);
        assert_eq!(desktop_bounds([(0, 0, 0, 1080)]), None);
        assert_eq!(
            desktop_bounds([(0, 0, 1920, 1080)]),
            Some((0, 0, 1920, 1080))
        );
    }

    #[test]
    fn reused_window_keeps_existing_border_compensation() {
        assert_eq!(
            corrected_outer_position(
                PhysicalPosition::new(-9, -5),
                PhysicalPosition::new(0, 0),
                PhysicalPosition::new(0, 0),
            ),
            None
        );
        assert_eq!(
            corrected_outer_position(
                PhysicalPosition::new(-9, -5),
                PhysicalPosition::new(0, 0),
                PhysicalPosition::new(-2560, -1080),
            ),
            Some(PhysicalPosition::new(-2569, -1085))
        );
    }
}

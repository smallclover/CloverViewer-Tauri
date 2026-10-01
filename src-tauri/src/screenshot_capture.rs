//! Screen capture metadata and immutable, unencoded RGBA frames.
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct ScreenData {
    /// 该屏在虚拟桌面中的物理坐标（左上角）
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 每个 monitor 的原始 xcap 元数据（物理像素 + scale factor + primary）。
/// 暴露给前端仅用于 console.info 排查多屏混合 DPI / 跨屏坐标偏移问题，
/// 不参与运行逻辑。运行时零开销（只在 `get_screenshot_data` 里走一次 clone）。
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

#[derive(Debug, Clone, Serialize)]
pub struct ScreenshotData {
    pub capture_id: u64,
    /// 虚拟桌面包围盒（物理像素）
    pub min_x: i32,
    pub min_y: i32,
    pub total_width: u32,
    pub total_height: u32,
    pub screens: Vec<ScreenData>,
    /// 见 `MonitorInfo` 说明。
    pub monitor_info: Vec<MonitorInfo>,
    /// 截图触发时的鼠标虚拟桌面物理坐标；前端据此把普通截图提示放在当前显示器。
    pub cursor: Option<CursorPosition>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CursorPosition {
    pub x: i32,
    pub y: i32,
}

pub struct CapturedScreenshot {
    pub data: ScreenshotData,
    frames: Vec<Arc<Vec<u8>>>,
}

impl CapturedScreenshot {
    pub fn frame(&self, capture_id: u64, screen_index: usize) -> Result<Arc<Vec<u8>>, String> {
        if self.data.capture_id != capture_id {
            return Err("Screenshot session has expired".into());
        }
        self.frames
            .get(screen_index)
            .cloned()
            .ok_or_else(|| "Screenshot screen index is out of range".into())
    }
}

pub fn capture_all(capture_id: u64) -> Result<CapturedScreenshot, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;

    let mut screens = Vec::new();
    let mut frames = Vec::new();
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

        frames.push(Arc::new(img.into_raw()));

        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + width as i32);
        max_y = max_y.max(y + height as i32);

        screens.push(ScreenData {
            x,
            y,
            width,
            height,
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

    // 诊断日志：每个 monitor 的原始 xcap 元数据（物理像素、scale factor、image 尺寸）。
    // 多屏/混合 DPI 的坐标问题靠猜是修不掉的（已经返工三轮），输出到 stderr，
    // 让用户截图发回或下一步接 tracing 都方便。release 构建下也能保留。
    eprintln!("[screenshot] monitors (raw, all values physical px):");
    for (i, mi) in monitor_info.iter().enumerate() {
        eprintln!(
            "[screenshot]   [{}] x={} y={} m.w={} m.h={} img={}x{} scale={} primary={}",
            i,
            mi.x,
            mi.y,
            mi.width,
            mi.height,
            mi.img_width,
            mi.img_height,
            mi.scale_factor,
            mi.is_primary
        );
    }
    eprintln!(
        "[screenshot] virtual desktop: minX={} minY={} totalW={} totalH={}",
        min_x,
        min_y,
        max_x - min_x,
        max_y - min_y
    );

    #[cfg(target_os = "windows")]
    let cursor = {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut point = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut point) }
            .ok()
            .map(|_| CursorPosition {
                x: point.x,
                y: point.y,
            })
    };
    #[cfg(not(target_os = "windows"))]
    let cursor = None;

    Ok(CapturedScreenshot {
        frames,
        data: ScreenshotData {
            capture_id,
            min_x,
            min_y,
            total_width: (max_x - min_x).max(1) as u32,
            total_height: (max_y - min_y).max(1) as u32,
            screens,
            monitor_info,
            cursor,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> CapturedScreenshot {
        CapturedScreenshot {
            data: ScreenshotData {
                capture_id: 7,
                min_x: -2,
                min_y: 0,
                total_width: 2,
                total_height: 1,
                screens: vec![ScreenData {
                    x: -2,
                    y: 0,
                    width: 2,
                    height: 1,
                }],
                monitor_info: vec![],
                cursor: None,
            },
            frames: vec![Arc::new(vec![255, 0, 0, 255, 0, 37, 255, 255])],
        }
    }

    #[test]
    fn frame_requests_require_the_current_session_and_screen() {
        let capture = snapshot();
        assert!(capture.frame(6, 0).is_err());
        assert!(capture.frame(7, 1).is_err());
        assert_eq!(
            capture.frame(7, 0).unwrap().as_slice(),
            &[255, 0, 0, 255, 0, 37, 255, 255]
        );
    }

    #[test]
    fn inflight_frame_survives_close_without_copying_the_capture_buffer() {
        let capture = snapshot();
        let frame = capture.frame(7, 0).unwrap();
        assert!(Arc::ptr_eq(&frame, &capture.frames[0]));
        drop(capture);
        assert_eq!(frame.len(), 8);
        assert_eq!(frame[5], 37);
    }
}

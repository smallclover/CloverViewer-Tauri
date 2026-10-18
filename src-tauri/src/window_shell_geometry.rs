//! 主界面和角色共享的物理像素布局；不依赖 HWND 或 WebView。
use crate::config::{normalize_decoration_scale, WindowDecoration};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Insets {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub insets: Insets,
    pub style: WindowDecoration,
    pub artwork_width: u32,
    pub artwork_height: u32,
    pub controls_width: u32,
    pub capture_id: Option<u64>,
}

pub fn layout(style: WindowDecoration, scale: u16, dpi: f64, maximized: bool) -> Layout {
    let px = |value: f64| (value * dpi).round().max(0.0) as u32;
    let multiplier = f64::from(normalize_decoration_scale(scale)) / 100.0;
    let (width, height) = match style {
        WindowDecoration::Peek => (240.0 * multiplier, 120.0 * multiplier),
        WindowDecoration::Lean => (160.0 * multiplier, 240.0 * multiplier),
        WindowDecoration::Off => (0.0, 0.0),
    };
    let shadow = px(10.0);
    let mut insets = Insets {
        left: shadow,
        top: shadow,
        right: shadow,
        bottom: shadow,
    };
    match style {
        WindowDecoration::Peek => insets.top += px(height * 0.915),
        WindowDecoration::Lean => {
            insets.right += px(width * 0.40);
            insets.bottom += px(height * 0.385);
        }
        WindowDecoration::Off => {}
    }
    Layout {
        insets: if maximized { Insets::default() } else { insets },
        style: if maximized {
            WindowDecoration::Off
        } else {
            style
        },
        artwork_width: px(width),
        artwork_height: px(height),
        controls_width: px(150.0),
        capture_id: None,
    }
}

pub fn panel_contains(insets: Insets, width: i32, height: i32, x: i32, y: i32) -> bool {
    x >= insets.left as i32
        && y >= insets.top as i32
        && x < width - insets.right as i32
        && y < height - insets.bottom as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_size_reserves_the_complete_character_beyond_the_panel() {
        for scale in (60..=140).step_by(5) {
            for dpi in [1.0, 1.25, 1.5, 2.0, 3.0] {
                for style in [WindowDecoration::Lean, WindowDecoration::Peek] {
                    let model = layout(style, scale, dpi, false);
                    let i = model.insets;
                    if style == WindowDecoration::Peek {
                        assert!(f64::from(i.top) >= f64::from(model.artwork_height) * 0.915);
                    } else {
                        assert!(f64::from(i.right) >= f64::from(model.artwork_width) * 0.40);
                        assert!(f64::from(i.bottom) >= f64::from(model.artwork_height) * 0.385);
                    }
                    assert!(panel_contains(i, 1800, 1600, i.left as i32, i.top as i32));
                    assert!(!panel_contains(
                        i,
                        1800,
                        1600,
                        i.left as i32,
                        i.top as i32 - 1
                    ));
                    assert!(!panel_contains(i, 1800, 1600, 1800 - i.right as i32, 800));
                }
            }
        }
    }
    #[test]
    fn maximizing_removes_gutters_and_screenshots_do_not_need_to_resize_the_panel() {
        for style in [
            WindowDecoration::Off,
            WindowDecoration::Lean,
            WindowDecoration::Peek,
        ] {
            let model = layout(style, 140, 1.5, true);
            assert_eq!(model.insets, Insets::default());
            assert_eq!(model.style, WindowDecoration::Off);
            let mut capture = layout(style, 140, 1.5, false);
            let normal = capture.insets;
            capture.style = WindowDecoration::Off;
            assert_eq!(capture.insets, normal);
        }
    }
}

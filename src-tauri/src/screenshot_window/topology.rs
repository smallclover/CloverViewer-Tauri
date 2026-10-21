//! 窗口复用以完整显示器布局为边界；相同桌面包围盒不代表相同 DPI 或屏幕组合。
use tauri::AppHandle;

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Display {
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: u64,
    primary: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Topology(Vec<Display>);

impl Topology {
    fn new(mut displays: Vec<Display>) -> Self {
        // Windows 的枚举顺序变化不应单独触发重建。
        displays.sort_unstable();
        Self(displays)
    }

    pub(super) fn read(app: &AppHandle) -> tauri::Result<Self> {
        let primary = app.primary_monitor()?;
        let displays = app
            .available_monitors()?
            .into_iter()
            .map(|monitor| Display {
                name: monitor.name().cloned(),
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width,
                height: monitor.size().height,
                scale: monitor.scale_factor().to_bits(),
                primary: primary.as_ref().is_some_and(|primary| {
                    primary.position() == monitor.position() && primary.name() == monitor.name()
                }),
            })
            .collect();
        Ok(Self::new(displays))
    }

    pub(super) fn bounds(&self) -> Option<super::DesktopBounds> {
        super::desktop_bounds(
            self.0
                .iter()
                .map(|display| (display.x, display.y, display.width, display.height)),
        )
    }

    pub(super) fn matches_capture(&self, data: &crate::screenshot_capture::ScreenshotData) -> bool {
        let mut captured: Vec<_> = data
            .screens
            .iter()
            .map(|screen| (screen.x, screen.y, screen.width, screen.height))
            .collect();
        let mut current: Vec<_> = self
            .0
            .iter()
            .map(|display| (display.x, display.y, display.width, display.height))
            .collect();
        captured.sort_unstable();
        current.sort_unstable();
        captured == current
    }
}

/// 与创建互斥共用同一把锁，只有新窗口成功创建后才记录它使用的布局。
#[derive(Default)]
pub(crate) struct WindowState {
    pub(super) topology: Option<Topology>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(name: &str, x: i32, width: u32, scale: f64) -> Display {
        Display {
            name: Some(name.into()),
            x,
            y: 0,
            width,
            height: 1080,
            scale: scale.to_bits(),
            primary: x == 0,
        }
    }

    #[test]
    fn hotplug_changes_reuse_identity_even_when_desktop_bounds_stay_the_same() {
        let dual = Topology::new(vec![
            display("left", 0, 1920, 1.0),
            display("right", 1920, 1920, 1.0),
        ]);
        let single = Topology::new(vec![display("wide", 0, 3840, 1.0)]);
        assert_eq!(dual.bounds(), single.bounds());
        assert_ne!(dual, single);
        let dpi_changed = Topology::new(vec![
            display("left", 0, 1920, 1.5),
            display("right", 1920, 1920, 1.0),
        ]);
        assert_eq!(dual.bounds(), dpi_changed.bounds());
        assert_ne!(dual, dpi_changed);
    }

    #[test]
    fn added_removed_rearranged_and_replaced_displays_invalidate_the_window() {
        let original = Topology::new(vec![display("primary", 0, 1920, 1.0)]);
        for changed in [
            vec![
                display("primary", 0, 1920, 1.0),
                display("left", -1920, 1920, 1.0),
            ],
            vec![display("primary", 0, 2560, 1.0)],
            vec![display("primary", -1920, 1920, 1.0)],
            vec![display("replacement", 0, 1920, 1.0)],
        ] {
            let changed = Topology::new(changed);
            assert_ne!(original, changed);
            assert_ne!(
                changed, original,
                "removing a monitor also invalidates reuse"
            );
        }
    }

    #[test]
    fn enumeration_order_is_irrelevant_but_primary_monitor_is_part_of_identity() {
        let original = Topology::new(vec![
            display("a", 0, 1920, 1.0),
            display("b", 1920, 1920, 1.0),
        ]);
        let reordered = Topology::new(vec![
            display("b", 1920, 1920, 1.0),
            display("a", 0, 1920, 1.0),
        ]);
        assert_eq!(original, reordered);
        let mut changed = reordered;
        for monitor in &mut changed.0 {
            monitor.primary = !monitor.primary;
        }
        assert_ne!(original, changed);
    }

    #[test]
    fn pixels_captured_before_hotplug_cannot_be_shown_in_a_different_monitor_layout() {
        use crate::screenshot_capture::{ScreenData, ScreenshotData};
        let data = ScreenshotData {
            capture_id: 1,
            min_x: 0,
            min_y: 0,
            total_width: 3840,
            total_height: 1080,
            screens: vec![
                ScreenData {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
                ScreenData {
                    x: 1920,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            ],
            monitor_info: vec![],
            cursor: None,
        };
        let dual = Topology::new(vec![
            display("a", 0, 1920, 1.0),
            display("b", 1920, 1920, 1.0),
        ]);
        assert!(dual.matches_capture(&data));
        let single = Topology::new(vec![display("a", 0, 3840, 1.0)]);
        assert_eq!(dual.bounds(), single.bounds());
        assert!(!single.matches_capture(&data));
        let removed = Topology::new(vec![display("a", 0, 1920, 1.0)]);
        assert!(!removed.matches_capture(&data));
        let rearranged = Topology::new(vec![
            display("a", 0, 1920, 1.0),
            display("b", -1920, 1920, 1.0),
        ]);
        assert!(!rearranged.matches_capture(&data));
    }
}

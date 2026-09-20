//! 滚动截图（长截图）。
//!
//! 此门面保留原有公开 API；实现按平台、图像匹配、会话和 Tauri 适配拆入子模块。
#![allow(dead_code)]

#[path = "scroll_capture/frame_metrics.rs"]
mod frame_metrics;
#[path = "scroll_capture/frame_shift.rs"]
pub mod frame_shift;
#[path = "scroll_capture/grayscale.rs"]
mod grayscale;
#[path = "scroll_capture/stitching.rs"]
mod stitching;

mod matching;
mod platform;
mod preview;
mod session;
mod session_auto;
mod session_manual;
pub mod tauri;
mod types;

pub use frame_shift::ShiftEstimate;
pub use matching::{estimate_shift, match_frames, tolerant_shift, MatchParams, MatchResult};
pub use platform::{
    capture_rect, client_rect, deepest_child_at, ensure_dpi_aware, focus_window, foreground_window,
    frame_diff_ratio, inject_scroll, list_top_windows, maximize_window, resolve_window,
    root_window, scroll_state, scroll_state_deepest, scroll_to_top, settle_capture,
    settle_capture_ext, virtual_screen, window_below_own_at, window_rect, WHEEL_DELTA,
};
pub use session::{
    park_point, FrameHideGate, NoHost, ScrollCaptureProgress, ScrollCaptureRequest,
    ScrollCaptureResult, SessionHost, SessionOptions,
};
pub use session_auto::{run_session, run_session_ext};
pub use session_manual::run_manual_session_ext;
pub use tauri::{
    discard_scroll_capture, finish_scroll_capture, has_scroll_capture_result,
    scroll_capture_progress, scroll_capture_running, set_scroll_hud_safe, start_scroll_capture,
    stop_scroll_capture, ScrollCaptureSession,
};
pub use types::{RectPx, ScrollMethod, ScrollState, SettleResult, WinInfo};

#[cfg(test)]
pub(crate) use platform::make_lparam;
#[cfg(test)]
pub(crate) use types::exclude_full_window_scrollbar;

#[cfg(test)]
mod tests;

//! Automatic driver for the shared V2 capture engine.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use image::RgbaImage;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use super::engine::{CaptureEngine, EngineEvent};
use super::preview::{encode_png, frame_data_url};
use super::session::{
    park_point, with_cursor_at, CursorGuard, FrameHideGate, ScrollCaptureProgress,
    ScrollCaptureRequest, ScrollCaptureResult, SessionCleanup, SessionHost, SessionLog,
    SessionOptions, MAX_CANVAS_BYTES,
};
use super::{
    deepest_child_at, frame_diff_ratio, inject_scroll, list_top_windows, root_window,
    scroll_state_deepest, scroll_to_top, settle_capture, ScrollMethod,
};

const MIN_SELECTION_HEIGHT: u32 = 280;
const MAX_UNCERTAIN_FRAMES: u32 = 3;
const MAX_NO_MOTION: u32 = 3;
const METHOD_CANDIDATES: [ScrollMethod; 5] = [
    ScrollMethod::WheelPost,
    ScrollMethod::WheelInput,
    ScrollMethod::WheelPostRoot,
    ScrollMethod::PageDown,
    ScrollMethod::VScroll,
];

pub fn run_session(
    req: &ScrollCaptureRequest,
    options: &SessionOptions,
    host: &dyn SessionHost,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(ScrollCaptureProgress),
) -> Result<ScrollCaptureResult, String> {
    run_session_ext(req, options, host, cancel, None, None, on_progress)
}

pub fn run_session_ext(
    req: &ScrollCaptureRequest,
    options: &SessionOptions,
    host: &dyn SessionHost,
    cancel: &AtomicBool,
    _hud_overlap: Option<&AtomicBool>,
    on_frame_capture: Option<Box<dyn FnMut(bool) + Send>>,
    on_progress: &mut dyn FnMut(ScrollCaptureProgress),
) -> Result<ScrollCaptureResult, String> {
    let cap = req.rect();
    validate_rect(&cap)?;
    let (cx, cy) = cap.center();
    let deepest =
        deepest_child_at(cx, cy).ok_or_else(|| "选区内没有可操作的目标窗口".to_string())?;
    let root = root_window(deepest);
    let mut log = SessionLog::open(&format!(
        "v2 auto rect={},{} {}x{} root=0x{root:X} deepest=0x{deepest:X}",
        cap.x, cap.y, cap.w, cap.h
    ));
    let target_note = list_top_windows()
        .into_iter()
        .find(|window| window.hwnd == root)
        .map(|window| format!("class={} title={}", window.class, window.title))
        .unwrap_or_else(|| "top-level window metadata unavailable".to_string());
    tracing::info!("滚动截图 V2: root=0x{root:X}, deepest=0x{deepest:X}, {target_note}");
    log.log(&format!("target {target_note}"));

    let gate = Rc::new(RefCell::new(FrameHideGate::new(on_frame_capture)));
    gate.borrow_mut()
        .set_keep_hidden(req.hide_hud_during_capture);
    gate.borrow_mut()
        .set_hide_each_frame(req.hide_glow_during_capture);
    let _cleanup = SessionCleanup {
        host,
        gate: gate.clone(),
    };

    let mut cursor = POINT { x: 0, y: 0 };
    let cursor_guard = CursorGuard {
        had: unsafe { GetCursorPos(&mut cursor).is_ok() },
        pos: cursor,
    };
    let (park_x, park_y) = park_point(&cap);
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::SetCursorPos(park_x, park_y);
    }

    if options.focus_target {
        host.focus_target(root);
    }
    host.set_escape_hook(true);
    host.set_progress(true, 0.0);

    if options.auto_scroll_top {
        let method = options.method.unwrap_or(ScrollMethod::WheelPost);
        if is_wheel(method) {
            let _ = with_cursor_at(&cap, method, || {
                scroll_to_top(root, &cap, method, 60).map(|_| String::new())
            });
            std::thread::sleep(Duration::from_millis(options.poll_ms));
        }
    }

    let first = capture_settled(&cap, options, &gate)?;
    let mut engine = CaptureEngine::new(first);
    emit(on_progress, "capturing", &cap, &engine, None, None, None);

    let mut method = options.method;
    let mut candidate_index = 0usize;
    let mut notches = options.notches.unwrap_or(1);
    let mut no_motion = 0u32;
    let mut partial_reason: Option<String> = None;
    let mut attempted_methods: Vec<&'static str> = Vec::new();

    while engine.frames() < options.max_frames && engine.height() < options.max_height_px {
        if cancel.load(Ordering::Relaxed) {
            partial_reason = Some("已停止并保留全部已验证内容".into());
            break;
        }
        if engine.frames() > 1
            && scroll_state_deepest(root, cx, cy).is_some_and(|state| state.at_bottom())
        {
            break;
        }
        let selected = method.unwrap_or_else(|| METHOD_CANDIDATES[candidate_index]);
        attempted_methods.push(selected.name());
        host.set_passthrough(selected == ScrollMethod::WheelInput);
        if selected == ScrollMethod::WheelInput {
            // Tauri applies the click-through flag through the native window
            // loop.  Sending input in the same instant can still target our
            // full-screen overlay, especially on a secondary monitor.
            std::thread::sleep(Duration::from_millis(80));
        }
        let scroll = with_cursor_at(&cap, selected, || {
            inject_scroll(root, &cap, selected, notches)
        });
        if selected != ScrollMethod::WheelInput {
            host.set_passthrough(false);
        }
        if let Err(error) = scroll {
            host.set_passthrough(false);
            log.log(&format!("try {}: injection error {error}", selected.name()));
            if method.is_none() && candidate_index + 1 < METHOD_CANDIDATES.len() {
                candidate_index += 1;
                continue;
            }
            return Err(format!("无法向所选内容发送滚动事件：{error}"));
        }
        log.log(&format!("try {}: injection sent", selected.name()));

        let current = capture_settled(&cap, options, &gate)?;
        host.set_passthrough(false);
        let diff = frame_diff_ratio(engine.last_frame(), &current);
        tracing::info!(
            "滚动截图 V2: method={} pixel_diff={diff:.5}",
            selected.name()
        );
        log.log(&format!("{} pixel_diff={diff:.5}", selected.name()));
        let candidate_preview = frame_data_url(&current);
        match engine.ingest(current)? {
            EngineEvent::Appended { shift, support, .. } => {
                method = Some(selected);
                no_motion = 0;
                log.log(&format!(
                    "{} accepted shift={shift} support={support:.3}",
                    selected.name()
                ));
                // Aim for about 55% overlap. This only changes the next input,
                // never the accepted seam.
                if options.notches.is_none() {
                    notches =
                        ((cap.h as f32 * 0.45 / shift.max(1) as f32).round() as u32).clamp(1, 6);
                }
                let message = Some(format!(
                    "已验证位移 {shift}px（匹配 {:.0}%）",
                    support * 100.0
                ));
                emit(
                    on_progress,
                    "matched",
                    &cap,
                    &engine,
                    Some(selected),
                    candidate_preview.clone(),
                    message,
                );
            }
            EngineEvent::NoMotion => {
                if method.is_none() && candidate_index + 1 < METHOD_CANDIDATES.len() {
                    candidate_index += 1;
                    // Discovery must exhaust every supported injection method.
                    // The first V2 pass stopped after three no-motion frames,
                    // never reaching PageDown/VScroll for native applications.
                    log.log(&format!(
                        "{} produced no motion; trying {} next",
                        selected.name(),
                        METHOD_CANDIDATES[candidate_index].name()
                    ));
                    emit(
                        on_progress,
                        "capturing",
                        &cap,
                        &engine,
                        Some(selected),
                        candidate_preview.clone(),
                        Some(format!("{} 无响应，正在尝试其他滚动方式…", selected.name())),
                    );
                    continue;
                }
                no_motion += 1;
                log.log(&format!(
                    "{} produced no motion ({no_motion})",
                    selected.name()
                ));
                if no_motion >= MAX_NO_MOTION {
                    if method.is_none() {
                        return Err(format!(
                            "无法让选区发生滚动：已尝试 {}。请确认只框选可滚动正文，或改用手动滚动。",
                            attempted_methods.join("、")
                        ));
                    }
                    partial_reason = Some("连续滚动未产生可信的新内容，已停止".into());
                    break;
                }
                emit(
                    on_progress,
                    "capturing",
                    &cap,
                    &engine,
                    Some(selected),
                    candidate_preview.clone(),
                    Some("等待内容继续滚动…".into()),
                );
            }
            EngineEvent::Reverse => {
                log.log(&format!("{} registered reverse motion", selected.name()));
                partial_reason = Some("检测到内容向上回退，已停止以避免错序".into());
                break;
            }
            EngineEvent::StaticRegion { percent } => {
                log.log(&format!(
                    "{} detected static region {percent}%",
                    selected.name()
                ));
                return Err(format!(
                    "选区约 {percent}% 是固定侧栏或窗口控件。请只框选可滚动正文后重试。"
                ));
            }
            EngineEvent::Uncertain { reason } => {
                log.log(&format!("{} uncertain: {reason}", selected.name()));
                if engine.uncertain_frames() >= MAX_UNCERTAIN_FRAMES {
                    partial_reason =
                        Some(format!("连续帧无法可靠配准（{reason}），已停止以避免错拼"));
                    break;
                }
                emit(
                    on_progress,
                    "low_confidence",
                    &cap,
                    &engine,
                    Some(selected),
                    candidate_preview.clone(),
                    Some(format!("本帧未采用：{reason}")),
                );
            }
        }
        let ratio = engine.height() as f32 / options.max_height_px as f32;
        host.set_progress(true, ratio);
    }
    drop(cursor_guard);
    finish(engine, partial_reason, options.max_height_px)
}

fn validate_rect(cap: &super::RectPx) -> Result<(), String> {
    if cap.w < 32 || cap.h < MIN_SELECTION_HEIGHT {
        return Err(format!(
            "选区至少需要 32×{MIN_SELECTION_HEIGHT} 像素；请只框选可滚动正文。"
        ));
    }
    Ok(())
}

fn capture_settled(
    cap: &super::RectPx,
    options: &SessionOptions,
    gate: &Rc<RefCell<FrameHideGate>>,
) -> Result<RgbaImage, String> {
    gate.borrow_mut().begin_frame();
    let result =
        settle_capture(cap, options.settle_timeout_ms, options.poll_ms).map(|frame| frame.image);
    gate.borrow_mut().end_frame();
    result
}

/// 自动滚动的进度上报：`stage` 直接决定 HUD 标签，低置信度时由调用方传
/// `"low_confidence"`，因此这里不再额外接收 `low` 标志（手动模式需要它，
/// 因为「等待匹配」是可恢复状态，必须保留原标签）。
fn emit(
    sink: &mut dyn FnMut(ScrollCaptureProgress),
    stage: &str,
    cap: &super::RectPx,
    engine: &CaptureEngine,
    method: Option<ScrollMethod>,
    candidate_preview: Option<String>,
    message: Option<String>,
) {
    let mut progress = ScrollCaptureProgress::bare(stage, cap).with_capture(cap);
    progress.frames = engine.frames();
    progress.width = engine.width();
    progress.height = engine.height();
    progress.method = method.map(|m| m.name().to_string());
    progress.message = message;
    progress.preview = engine.preview_data_url();
    progress.verified_preview = engine.verified_preview_data_url();
    progress.candidate_preview = candidate_preview.or_else(|| engine.verified_preview_data_url());
    sink(progress);
}

fn finish(
    engine: CaptureEngine,
    reason: Option<String>,
    max_height: u32,
) -> Result<ScrollCaptureResult, String> {
    let frames = engine.frames();
    if frames < 2 {
        return Err("没有获得两帧可可靠拼接的内容；请确认框选的是可滚动正文。".into());
    }
    let image = engine.finish()?;
    let bytes = image.width() as u64 * image.height() as u64 * 4;
    if bytes > MAX_CANVAS_BYTES {
        return Err("长图超过内存安全上限，已停止；请缩小范围或分段截图。".into());
    }
    let partial = reason.is_some() || image.height() >= max_height;
    Ok(ScrollCaptureResult {
        width: image.width(),
        height: image.height(),
        frames,
        confidence: if partial { "partial" } else { "high" }.into(),
        message: reason.or_else(|| {
            (image.height() >= max_height).then(|| "达到高度上限，已保留已验证内容".into())
        }),
        png: encode_png(&image, false)?,
    })
}

fn is_wheel(method: ScrollMethod) -> bool {
    matches!(
        method,
        ScrollMethod::WheelPost | ScrollMethod::WheelPostRoot | ScrollMethod::WheelInput
    )
}

//! 手动模式驱动：只观察用户滚动，仅追加已验证的行。

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use image::RgbaImage;

use super::engine::{CaptureEngine, EngineEvent};
use super::preview::{encode_png, frame_data_url};
use super::session::{
    FrameHideGate, ScrollCaptureProgress, ScrollCaptureRequest, ScrollCaptureResult,
    SessionCleanup, SessionHost, SessionOptions, MAX_CANVAS_BYTES,
};
use super::{capture_rect, deepest_child_at, frame_diff_ratio, root_window, settle_capture};

const MIN_SELECTION_HEIGHT: u32 = 280;
/// 单次探测的差异低于该值，几乎可以肯定是静止帧。
/// 与「配准」分开判定，用户只是在读页面时不必干等数秒的稳定等待。
const CHANGE_PROBE_THRESHOLD: f32 = 0.001;

pub fn run_manual_session_ext(
    req: &ScrollCaptureRequest,
    options: &SessionOptions,
    host: &dyn SessionHost,
    cancel: &AtomicBool,
    on_frame_capture: Option<Box<dyn FnMut(bool) + Send>>,
    on_progress: &mut dyn FnMut(ScrollCaptureProgress),
) -> Result<ScrollCaptureResult, String> {
    let cap = req.rect();
    if cap.w < 32 || cap.h < MIN_SELECTION_HEIGHT {
        return Err(format!(
            "选区至少需要 32×{MIN_SELECTION_HEIGHT} 像素；请只框选可滚动正文。"
        ));
    }
    let deepest = deepest_child_at(cap.center().0, cap.center().1)
        .ok_or_else(|| "选区内没有可操作的目标窗口".to_string())?;
    let root = root_window(deepest);
    let gate = Rc::new(RefCell::new(FrameHideGate::new(on_frame_capture)));
    gate.borrow_mut()
        .set_keep_hidden(req.hide_hud_during_capture);
    gate.borrow_mut()
        .set_hide_each_frame(req.hide_glow_during_capture);
    let _cleanup = SessionCleanup {
        host,
        gate: gate.clone(),
    };
    host.focus_target_for_manual(root);
    host.set_passthrough(true);
    host.set_escape_hook(true);
    host.set_progress(true, 0.0);

    let first = capture_settled(&cap, options, &gate)?;
    let mut engine = CaptureEngine::new(first);
    emit(
        on_progress,
        "capturing",
        &cap,
        &engine,
        None,
        Some("请向下缓慢滚动；程序只会追加已验证的内容。".into()),
        false,
    );
    // 手动模式只做观察者：不因为动画、弹窗或快速滚动产生的几帧难配准就替用户判定结束。
    // 只有用户明确 Finish/Esc，或达到文档化的资源上限，才会结束会话。
    let poll = options.poll_ms.clamp(20, 80);
    let (reason, partial) = loop {
        let safe_height = safe_height_limit(cap.w, options.max_height_px);
        if engine.frames() >= options.max_frames || engine.height() >= safe_height {
            break (Some("达到滚动截图上限，已保留已验证内容".into()), true);
        }
        let finishing = cancel.load(Ordering::Relaxed);
        // 首次快照只当作「有没有变化」的探测器：一旦画面动了，就等它稳定下来再采样，
        // 这样半张没画完的浏览器帧绝不会变成拼接锚点。Finish 时也走这条稳定采样，
        // 但仍要过 `ingest`，没有真正新增的行就丢弃。
        let current = if finishing {
            capture_settled(&cap, options, &gate)?
        } else {
            let probe = capture_once(&cap, &gate)?;
            if frame_diff_ratio(engine.last_frame(), &probe) < CHANGE_PROBE_THRESHOLD {
                host.set_progress(true, engine.height() as f32 / safe_height as f32);
                std::thread::sleep(Duration::from_millis(poll));
                continue;
            }
            capture_settled(&cap, options, &gate)?
        };
        let candidate_preview = frame_data_url(&current);
        let mut finish_note: Option<(String, bool)> = None;
        match engine.ingest(current)? {
            EngineEvent::Appended { shift, support, .. } => {
                emit(
                    on_progress,
                    "matched",
                    &cap,
                    &engine,
                    candidate_preview.clone(),
                    Some(format!(
                        "已验证位移 {shift}px（匹配 {:.0}%）",
                        support * 100.0
                    )),
                    false,
                );
            }
            EngineEvent::NoMotion => {
                // 用户在底部停下时，最后一帧稳定后没有新内容是正常结果。
                // 注意不要无条件追加这一帧：那会产生重复的尾部。
                if finishing {
                    finish_note = Some(("最后一帧没有新的正文，已跳过。".into(), false));
                    emit(
                        on_progress,
                        "finishing",
                        &cap,
                        &engine,
                        candidate_preview.clone(),
                        finish_note.as_ref().map(|(message, _)| message.clone()),
                        false,
                    );
                }
            }
            EngineEvent::Reverse => {
                if finishing {
                    finish_note = Some(("最后一帧是回滚画面，已保留此前验证的内容。".into(), true));
                }
                emit(
                    on_progress,
                    "waiting",
                    &cap,
                    &engine,
                    candidate_preview.clone(),
                    Some("检测到回滚；未追加。请回到最后一次绿色匹配的位置再继续。".into()),
                    true,
                );
            }
            EngineEvent::StaticRegion { percent } => {
                // 选区里有大片固定区域只是「选区质量」的警告，不构成静默丢弃整次手动会话的理由：
                // 用户可以调整滚动方式，用已验证的部分完成截图。
                if finishing {
                    finish_note = Some((
                        "最后一帧包含大量固定区域，已保留此前验证的内容。".into(),
                        true,
                    ));
                }
                emit(
                    on_progress,
                    "waiting",
                    &cap,
                    &engine,
                    candidate_preview.clone(),
                    Some(format!(
                        "选区约 {percent}% 似乎固定；本帧已跳过。建议只保留会移动的正文。"
                    )),
                    true,
                );
            }
            EngineEvent::Uncertain { reason } => {
                if finishing {
                    finish_note = Some((
                        format!("最后一帧无法可靠拼接（{reason}），已保留此前验证的内容。"),
                        true,
                    ));
                }
                emit(
                    on_progress,
                    "waiting",
                    &cap,
                    &engine,
                    candidate_preview.clone(),
                    Some(format!(
                        "本帧未采用：{reason}。请慢一点继续滚动，或回到最后一次绿色匹配的位置。"
                    )),
                    true,
                );
            }
        }
        host.set_progress(true, engine.height() as f32 / safe_height as f32);
        if finishing {
            break match finish_note {
                Some((message, partial)) => (Some(message), partial),
                None => (Some("已完成并保留全部已验证内容".into()), false),
            };
        }
        std::thread::sleep(Duration::from_millis(poll));
    };
    finish(engine, reason, partial)
}

fn safe_height_limit(width: u32, requested: u32) -> u32 {
    // 给当前帧、首帧和 PNG 编码留出余量：把可能的整进程分配失败变成可恢复的捕获上限。
    let bytes_per_row = (width as u64).saturating_mul(4).max(1);
    let memory_limited = (MAX_CANVAS_BYTES.saturating_mul(3) / 4 / bytes_per_row) as u32;
    requested.min(memory_limited.max(MIN_SELECTION_HEIGHT))
}

fn capture_once(
    cap: &super::RectPx,
    gate: &Rc<RefCell<FrameHideGate>>,
) -> Result<RgbaImage, String> {
    gate.borrow_mut().begin_frame();
    let result = capture_rect(cap);
    gate.borrow_mut().end_frame();
    result
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

fn emit(
    sink: &mut dyn FnMut(ScrollCaptureProgress),
    stage: &str,
    cap: &super::RectPx,
    engine: &CaptureEngine,
    candidate_preview: Option<String>,
    message: Option<String>,
    low: bool,
) {
    // `waiting` 是有意的可恢复状态，不要把它并进旧的通用「低置信」标签：
    // HUD 需要告诉用户「可以继续滚动，并从前一个绿色锚点恢复」。
    let reported_stage = if low && stage != "waiting" {
        "low_confidence"
    } else {
        stage
    };
    let mut progress = ScrollCaptureProgress::bare(reported_stage, cap).with_capture(cap);
    progress.frames = engine.frames();
    progress.width = engine.width();
    progress.height = engine.height();
    progress.method = Some("manual".into());
    progress.message = message;
    progress.input_passthrough = true;
    progress.preview = engine.preview_data_url();
    progress.verified_preview = engine.verified_preview_data_url();
    progress.candidate_preview = candidate_preview.or_else(|| engine.verified_preview_data_url());
    sink(progress);
}

fn finish(
    engine: CaptureEngine,
    reason: Option<String>,
    partial: bool,
) -> Result<ScrollCaptureResult, String> {
    let frames = engine.frames();
    if frames < 2 {
        return Err("没有获得两帧可可靠拼接的内容；请缓慢向下滚动后再完成。".into());
    }
    let image = engine.finish()?;
    if image.width() as u64 * image.height() as u64 * 4 > MAX_CANVAS_BYTES {
        return Err("长图超过内存安全上限，已停止；请缩小范围或分段截图。".into());
    }
    Ok(ScrollCaptureResult {
        width: image.width(),
        height: image.height(),
        frames,
        confidence: if partial { "partial" } else { "high" }.into(),
        message: reason,
        png: encode_png(&image, false)?,
    })
}

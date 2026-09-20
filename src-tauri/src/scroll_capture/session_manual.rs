use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use image::RgbaImage;

use super::matching::MIN_SHIFT;
use super::platform::capture_rect_without_full_window_scrollbar;
use super::preview::{encode_png, PreviewBuilder};
use super::session::{
    est_err_ok, FrameHideGate, ScrollCaptureProgress, ScrollCaptureRequest, ScrollCaptureResult,
    SessionHost, SessionOptions, MAX_CANVAS_BYTES, PREVIEW_MAX_H, PREVIEW_WIDTH,
};
use super::stitching::{append_band, attach_footer, trim_initial_footer};
use super::{
    capture_rect, deepest_child_at, match_frames, root_window, settle_capture, tolerant_shift,
    MatchParams,
};

/// 用户手动滚动的会话。
///
/// 这里刻意不复用 `run_session_ext` 的循环：后者的每一次循环都必然会向目标注入滚动。
/// 手动模式高频轮询捕获区的屏幕像素；用户可以连续滚动，程序会在滚动途中按实际位移
/// 收帧，而不是要求用户每一段都停下来留重叠。
/// 取消请求不是立即丢弃，而是先稳定采一次最后画面，因此用户停在的位置不会因按 Esc
/// 恰好早于下一轮轮询而漏进结果。
pub fn run_manual_session_ext(
    req: &ScrollCaptureRequest,
    o: &SessionOptions,
    host: &dyn SessionHost,
    cancel: &AtomicBool,
    on_frame_capture: Option<Box<dyn FnMut(bool) + Send>>,
    on_progress: &mut dyn FnMut(ScrollCaptureProgress),
) -> Result<ScrollCaptureResult, String> {
    let rect = req.rect();
    if rect.w < 32 || rect.h < 64 {
        return Err("选区太小：滚动截图至少需要 32×64 像素".to_string());
    }
    const MIN_SELECTION_H: u32 = 280;
    if rect.h < MIN_SELECTION_H {
        return Err(format!(
            "选区太矮：至少需要 {}px 高（当前 {}px）。请拉高选区后重试。",
            MIN_SELECTION_H, rect.h
        ));
    }

    let (cx, cy) = rect.center();
    let deepest =
        deepest_child_at(cx, cy).ok_or_else(|| "选区内没有可操作的目标窗口".to_string())?;
    let root = root_window(deepest);
    // 与自动模式一致：完整窗口框选时不捕获会移动的右侧滚动条滑块。
    let cap = capture_rect_without_full_window_scrollbar(rect, root);
    let params = MatchParams::for_height(cap.h);
    let canvas_w = cap.w;
    let frame_gate = Rc::new(RefCell::new(FrameHideGate::new(on_frame_capture)));
    frame_gate
        .borrow_mut()
        .set_keep_hidden(req.hide_hud_during_capture);
    frame_gate
        .borrow_mut()
        .set_hide_each_frame(req.hide_glow_during_capture);

    // 鼠标事件必须穿透透明覆盖窗；键盘焦点则留给目标窗口以支持 PageDown 等手动滚动。
    host.focus_target_for_manual(root);
    host.set_passthrough(true);
    host.set_escape_hook(true);

    let mut emit_progress = |stage: &str,
                             frames: u32,
                             height: u32,
                             preview: Option<String>,
                             message: Option<String>,
                             low_conf: bool| {
        // `done` / `partial` 是终态：即使此前低置信，也必须恢复 HUD 的鼠标命中，
        // 否则前端会沿用最后一帧的 click-through，结果面板上的复制/保存按钮无法点击。
        let terminal = matches!(stage, "done" | "partial");
        let mut p = ScrollCaptureProgress::bare(
            if terminal {
                stage
            } else if low_conf {
                "low_confidence"
            } else {
                stage
            },
            &cap,
        );
        p.frames = frames;
        p.width = canvas_w;
        p.height = height;
        p.method = Some("manual".to_string());
        p.message = message;
        p.input_passthrough = !terminal;
        p.preview = preview;
        on_progress(p.with_capture(&cap));
    };

    emit_progress(
        "capturing",
        0,
        0,
        None,
        Some("请自由向下滚动；程序会实时拼接。按 Esc 完成并收取最后一帧。".to_string()),
        false,
    );

    frame_gate.borrow_mut().begin_frame();
    let first = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms);
    frame_gate.borrow_mut().end_frame();
    let first = first?;
    let mut canvas = Vec::with_capacity(cap.w as usize * cap.h as usize * 4 * 4);
    let mut canvas_h = 0u32;
    append_band(&mut canvas, canvas_w, &mut canvas_h, &first.image, 0, 0, 0)?;
    let mut preview = PreviewBuilder::new(canvas_w, PREVIEW_WIDTH);
    preview.append_strip(&first.image, 0);
    let mut prev = first.image;
    let mut frames = 1u32;
    let mut last_shift: Option<u32> = None;
    let mut last_bottom_fixed = 0u32;
    let mut initial_footer_pending = true;
    let mut low_conf = false;
    let mut stop_reason: Option<String> = None;
    // 手动模式要比自动模式的「等待稳定」更快地采样：目标是让相邻帧自然保留大量重叠，
    // 用户无需刻意控制滚动距离。下限避免极小选区下无意义地占满 CPU。
    let manual_poll_ms = o.poll_ms.clamp(20, 40);

    emit_progress(
        "capturing",
        frames,
        canvas_h,
        preview.data_url(PREVIEW_MAX_H),
        Some("请自由向下滚动；程序会实时按实际位移拼接。按 Esc 完成。".to_string()),
        false,
    );

    let has_moved = |a: &RgbaImage, b: &RgbaImage| {
        match_frames(a, b, &params, None)
            .filter(|mm| mm.shift >= MIN_SHIFT)
            .is_some()
            || tolerant_shift(a, b)
                .filter(|(_, ratio)| *ratio < 0.8 && est_err_ok(a, b))
                .is_some()
    };

    loop {
        if frames >= o.max_frames {
            stop_reason = Some(format!("达到帧数上限 {}，已保留当前结果", o.max_frames));
            break;
        }
        if canvas_h >= o.max_height_px {
            stop_reason = Some(format!(
                "达到高度上限 {}px，已保留当前结果",
                o.max_height_px
            ));
            break;
        }

        // 实时采样：触控板惯性、拖动滚动条、键盘和鼠标滚轮都会自然覆盖，
        // 而不用向用户目标窗口安装输入钩子。正常滚动绝不在这里等待稳定，
        // 否则用户连续滚一大段时只会留下首末两帧、反而要求他控制距离。
        let finishing = cancel.load(Ordering::Relaxed);
        let probe = capture_rect(&cap)?;
        if !finishing && !has_moved(&prev, &probe) {
            std::thread::sleep(Duration::from_millis(manual_poll_ms));
            continue;
        }

        // 只有用户按完成时才等待稳定。这样保证最终位置准确，同时不拖慢连续滚动的采样。
        let cur = if finishing {
            frame_gate.borrow_mut().begin_frame();
            let settled = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms);
            frame_gate.borrow_mut().end_frame();
            settled?.image
        } else {
            probe
        };

        // 回滚不会被追加到尾部；保持当前最高位置为参考帧，之后重新向下滚动时仍能正确续接。
        if match_frames(&cur, &prev, &params, last_shift)
            .filter(|m| m.shift >= MIN_SHIFT)
            .is_some()
        {
            emit_progress(
                "capturing",
                frames,
                canvas_h,
                preview.data_url(PREVIEW_MAX_H),
                Some("检测到向上回滚：未重复拼接，请回到最靠下的位置后继续向下滚动。".to_string()),
                low_conf,
            );
            if finishing {
                break;
            }
            continue;
        }

        let mut appended = false;
        match match_frames(&prev, &cur, &params, last_shift) {
            Some(m) if m.shift >= MIN_SHIFT => {
                if initial_footer_pending {
                    if trim_initial_footer(&mut canvas, canvas_w, &mut canvas_h, m.bottom_fixed) {
                        if let Some(body) = RgbaImage::from_raw(canvas_w, canvas_h, canvas.clone())
                        {
                            preview = PreviewBuilder::new(canvas_w, PREVIEW_WIDTH);
                            preview.append_strip(&body, 0);
                        }
                    }
                    initial_footer_pending = false;
                }
                let body_h = cur
                    .height()
                    .saturating_sub(m.top_fixed)
                    .saturating_sub(m.bottom_fixed);
                let append_from = body_h.saturating_sub(m.shift) + m.top_fixed;
                let net = cur
                    .height()
                    .saturating_sub(m.bottom_fixed)
                    .saturating_sub(append_from);
                let new_h = canvas_h + net;
                let weak = m.ambiguous
                    || (m.run as u64) * 2 < cur.height().saturating_sub(m.shift) as u64
                    || m.block_inlier_ratio < 0.75
                    || m.mean_block_error > 12.0
                    || (m.runner_up.is_some() && m.runner_up_gap < 0.08);
                if new_h as u64 * canvas_w as u64 * 4 > MAX_CANVAS_BYTES {
                    stop_reason = Some("结果过大（内存上限），已保留当前结果".to_string());
                } else {
                    append_band(
                        &mut canvas,
                        canvas_w,
                        &mut canvas_h,
                        &cur,
                        m.top_fixed,
                        m.bottom_fixed,
                        m.shift,
                    )?;
                    let strip =
                        image::imageops::crop_imm(&cur, 0, append_from, canvas_w, net).to_image();
                    preview.append_strip(&strip, canvas_h - net);
                    frames += 1;
                    last_shift = Some(m.shift);
                    last_bottom_fixed = m.bottom_fixed;
                    low_conf |= weak;
                    appended = true;
                }
            }
            Some(_) => {
                // 高频采样时常会遇到 1~3px 的细微位移。不能把 prev 前移，否则这些
                // 微小位移永远无法累积成可拼接的一段，用户慢慢滚会出现漏行。
            }
            None => {
                // 动态内容或亚像素重绘：容差路径仍可安全接上时才追加，绝不猜位移。
                if let Some((shift, ratio)) = tolerant_shift(&prev, &cur)
                    .filter(|(_, ratio)| *ratio < 0.8 && est_err_ok(&prev, &cur))
                {
                    let footer_h = last_bottom_fixed.min(cur.height().saturating_sub(1));
                    let shift = shift.min(cur.height().saturating_sub(footer_h).saturating_sub(1));
                    if shift >= MIN_SHIFT {
                        let append_from =
                            cur.height().saturating_sub(footer_h).saturating_sub(shift);
                        let net = cur
                            .height()
                            .saturating_sub(footer_h)
                            .saturating_sub(append_from);
                        append_band(
                            &mut canvas,
                            canvas_w,
                            &mut canvas_h,
                            &cur,
                            0,
                            footer_h,
                            shift,
                        )?;
                        if net > 0 {
                            let strip =
                                image::imageops::crop_imm(&cur, 0, append_from, canvas_w, net)
                                    .to_image();
                            preview.append_strip(&strip, canvas_h - net);
                        }
                        frames += 1;
                        last_shift = Some(shift);
                        low_conf = true;
                        appended = true;
                        tracing::debug!(
                            "手动滚动截图: 使用容差配准 shift={shift} ratio={ratio:.3}"
                        );
                    }
                } else {
                    low_conf = true;
                }
            }
        }

        if appended {
            prev = cur;
        }
        emit_progress(
            "capturing",
            frames,
            canvas_h,
            preview.data_url(PREVIEW_MAX_H),
            if low_conf && !appended {
                Some("当前画面无法可靠配准（可能有动画或重复布局）；可继续滚动，或按 Esc 收取当前结果。".to_string())
            } else if finishing {
                Some("正在收取最后一帧…".to_string())
            } else {
                Some("正在实时拼接；可连续滚动，无需控制每次距离。".to_string())
            },
            low_conf,
        );
        host.set_progress(true, canvas_h as f32 / o.max_height_px.max(1) as f32);
        if finishing || stop_reason.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(manual_poll_ms));
    }

    host.set_progress(false, 0.0);
    frame_gate.borrow_mut().restore();
    attach_footer(
        &mut canvas,
        canvas_w,
        &mut canvas_h,
        &prev,
        last_bottom_fixed,
    );
    if canvas_h <= cap.h.saturating_sub(last_bottom_fixed) {
        return Err("没有捕获到可拼接的内容（请先向下滚动至少一段，再按 Esc 完成）".to_string());
    }
    let img = RgbaImage::from_raw(canvas_w, canvas_h, canvas)
        .ok_or_else(|| "拼接缓冲区尺寸不一致".to_string())?;
    let png = encode_png(&img, false)?;
    let confidence = if stop_reason.is_some() {
        "partial"
    } else if low_conf {
        "low"
    } else {
        "high"
    };
    let result = ScrollCaptureResult {
        width: canvas_w,
        height: canvas_h,
        frames,
        confidence: confidence.to_string(),
        message: stop_reason,
        png,
    };
    emit_progress(
        if result.confidence == "partial" {
            "partial"
        } else {
            "done"
        },
        result.frames,
        result.height,
        preview.data_url(PREVIEW_MAX_H),
        result.message.clone(),
        result.confidence == "low",
    );
    Ok(result)
}

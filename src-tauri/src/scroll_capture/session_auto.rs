use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use image::RgbaImage;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use super::matching::MIN_SHIFT;
use super::platform::{capture_rect_without_full_window_scrollbar, hwnd_from, window_info};
use super::preview::{encode_png, PreviewBuilder};
use super::session::{
    est_err_ok, park_point, with_cursor_at, CursorGuard, FrameHideGate, ScrollCaptureProgress,
    ScrollCaptureRequest, ScrollCaptureResult, SessionCleanup, SessionHost, SessionLog,
    SessionOptions, MAX_CANVAS_BYTES, PREVIEW_MAX_H, PREVIEW_WIDTH,
};
use super::stitching::{append_band, attach_footer, duplicate_ratio, trim_initial_footer};
use super::{
    deepest_child_at, frame_diff_ratio, inject_scroll, match_frames, root_window, scroll_state,
    scroll_to_top, settle_capture, tolerant_shift, MatchParams, ScrollMethod,
};

const SAME_FRAME_RATIO: f32 = 0.0005;
const SCROLLED_DIFF_RATIO: f32 = 0.002;
const MAX_MATCH_FAILURES: u32 = 3;

/// 跑完整个滚动截图会话（探测 → 逐帧捕获拼接 → 返回长图 PNG）。
///
/// 这是 P1 的核心：Tauri 命令与命令行探针共用同一份实现。
pub fn run_session(
    req: &ScrollCaptureRequest,
    o: &SessionOptions,
    host: &dyn SessionHost,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(ScrollCaptureProgress),
) -> Result<ScrollCaptureResult, String> {
    run_session_ext(req, o, host, cancel, None, None, on_progress)
}

/// `run_session` 的扩展版：多一个 HUD 重叠状态与宿主通知回调。
///
/// Tauri 侧只在 HUD 与捕获区重叠、且 Windows 捕获排除不可用时让前端隐藏它，并从首帧保持到会话结束。
/// 普通小选区无需切换可见性，因而不会出现逐帧闪烁。
/// 命令行探针传 `None`，行为与以前完全一致。
pub fn run_session_ext(
    req: &ScrollCaptureRequest,
    o: &SessionOptions,
    host: &dyn SessionHost,
    cancel: &AtomicBool,
    _hud_overlap: Option<&AtomicBool>,
    on_frame_capture: Option<Box<dyn FnMut(bool) + Send>>,
    on_progress: &mut dyn FnMut(ScrollCaptureProgress),
) -> Result<ScrollCaptureResult, String> {
    let rect = req.rect();
    if rect.w < 32 || rect.h < 64 {
        return Err("选区太小：滚动截图至少需要 32×64 像素".to_string());
    }

    let (cx, cy) = rect.center();
    let deepest =
        deepest_child_at(cx, cy).ok_or_else(|| "选区内没有可操作的目标窗口".to_string())?;
    let root = root_window(deepest);
    {
        // 诊断：把「最终认定的目标窗口」写进日志。多屏/覆盖窗/置顶窗叠在一起时，
        // 光看现象根本分不清滚轮到底发给了谁（P1 端到端就是这么被抓出来的）。
        let info = window_info(hwnd_from(root));
        tracing::info!(
            "滚动截图: 目标窗口 0x{root:X} class={} title={} (命中点 {cx},{cy})",
            info.as_ref().map(|w| w.class.clone()).unwrap_or_default(),
            info.as_ref().map(|w| w.title.clone()).unwrap_or_default()
        );
    }

    // HUD 重叠才整段隐藏；自动滚动光晕则仅在每次 BitBlt 前后让开。
    // 两个状态都随启动请求携带，避免独立异步上报与首帧竞争。
    let hide_hud_for_session = req.hide_hud_during_capture;
    let hide_glow_each_frame = req.hide_glow_during_capture;
    let frame_gate = Rc::new(RefCell::new(FrameHideGate::new(on_frame_capture)));
    frame_gate
        .borrow_mut()
        .set_keep_hidden(hide_hud_for_session);
    frame_gate
        .borrow_mut()
        .set_hide_each_frame(hide_glow_each_frame);
    tracing::info!(
        "滚动截图: HUD{}，内扩光晕{}",
        if hide_hud_for_session {
            "采集期间隐藏"
        } else {
            "保持可见"
        },
        if hide_glow_each_frame {
            "逐帧让开"
        } else {
            "未启用"
        },
    );

    // 会话期间光标一律停在选区外（避免悬停高亮污染帧），结束时恢复
    let mut original_cursor = POINT { x: 0, y: 0 };
    let had_cursor = unsafe { GetCursorPos(&mut original_cursor).is_ok() };
    let _cursor_guard = CursorGuard {
        had: had_cursor,
        pos: original_cursor,
    };

    // 实际捕获区：矮选区向下补足（宽度不变）。逐帧捕获与前端的「挖空范围」都用它。
    // 只有**确实太矮**的选区才补足高度：
    // 一次滚轮最多约 200px（DPI 125% 下 Chrome 约 125-190px），所以选区只要 ≥500px 高，
    // 一步滚完仍留 300px 以上重叠区 —— 完全不需要补。
    // 早期写成「补到选区高度的 2.5 倍」，而 2.5h > h 恒成立 → **每次都会补**，于是每次都在
    // 选区下方多出一条亮带（补出来的区域必须保持透明，否则遮罩会被截进长图），
    // 看起来就像选区自己变大了（用户实测报回）。现在常见选区根本不会补，界面干净。
    // 选区高度硬下限：低于 280px 时，常见的一格滚轮已经会吃光重叠区。
    // 280-399px 允许启动，等首个真实滚动测得位移后再做准确判定；400px 只是前端推荐值。
    //
    // 早期做法是「偷偷把捕获高度往上补」：补出来的区域**必须保持透明**（否则我们自己的压暗
    // 遮罩会被截进长图），于是界面上会多出一条亮带；而选区那条边框线又会落进捕获区里被截进
    // 长图（用户实测报回「绿线又回来了」）。与其做这种自相矛盾的补救，不如直接要求框高一点：
    // 诚实、界面干净、没有意外。
    const MIN_SELECTION_H: u32 = 280;
    if rect.h < MIN_SELECTION_H {
        return Err(format!(
            "选区太矮：至少需要 {}px 高（当前 {}px）。请拉高选区后重试。",
            MIN_SELECTION_H, rect.h
        ));
    }
    // 不再补足高度；仅在点选完整窗口时预留右侧滚动条，避免移动的滑块被逐帧拼成多段。
    // 普通自定义选区保持原样，用户可以精确控制裁切范围。
    let cap = capture_rect_without_full_window_scrollbar(rect, root);
    let mut dlog = SessionLog::open(&format!(
        "run_session rect={},{},{}x{}",
        rect.x, rect.y, rect.w, rect.h
    ));
    if cap != rect {
        dlog.log(&format!(
            "完整窗口选区：右侧预留 {}px 滚动条，capture={}x{}",
            rect.w - cap.w,
            cap.w,
            cap.h
        ));
    }
    let wheel_like = |m: ScrollMethod| {
        matches!(
            m,
            ScrollMethod::WheelPost | ScrollMethod::WheelPostRoot | ScrollMethod::WheelInput
        )
    };

    // 会话收尾的兜底租约：**必须在任何可能 `?` 提前返回的操作之前**声明，
    // 否则又会出现「早期返回时覆盖窗留在 click-through、全局 Esc 没注销」的泄漏。
    let session_cleanup = SessionCleanup {
        host,
        gate: frame_gate.clone(),
    };

    if o.focus_target {
        host.focus_target(root);
        std::thread::sleep(Duration::from_millis(120));
    }
    host.set_escape_hook(true);
    {
        let deep = deepest_child_at(cx, cy);
        dlog.log(&format!(
            "target root=0x{root:X} deepest={} park={:?} vscroll(root)={:?} vscroll(deep)={:?}",
            deep.map(|h| format!("0x{h:X}"))
                .unwrap_or_else(|| "none".into()),
            park_point(&cap),
            scroll_state(root),
            deep.and_then(scroll_state)
        ));
    }

    // ---- 1. 可选：回到顶部 ----
    //
    // **默认关闭**：默认行为是「从用户当前看到的位置顺着往下截」——框了一块内容就期待
    // 「从这儿开始一直往下」，而不是先跳到页面顶部（那是另一个意图，交给用户显式开启）。
    if o.auto_scroll_top {
        let m = o.method.unwrap_or(ScrollMethod::WheelPost);
        if wheel_like(m) {
            tracing::info!("滚动截图: 按设置先回到顶部");
            let _ = with_cursor_at(&cap, m, || {
                scroll_to_top(root, &cap, m, 60).map(|_| "scroll_to_top".to_string())
            });
            std::thread::sleep(Duration::from_millis(o.poll_ms));
        }
    }

    // ---- 2. 注入方式不预判：主循环里边滚边选 ----
    //
    // 早期实现会先「滚一格试一下」来挑方式并标定每格像素，代价是用户先看到画面跳一下
    // （回顶时再跳回去）——体验差。实际上**试错失败时画面根本不会动**（这正是失败的定义），
    // 所以完全可以把试错放进主循环：挨个试，谁先让画面动起来就用谁，而且成功那一次
    // 本身就是第一帧内容，不浪费、不抖动。
    let mut method: Option<ScrollMethod> = o.method;
    let mut notches = o.notches.unwrap_or(1);
    /// 主循环里「挨个试」的注入方式顺序：先试最通用的滚轮消息，再退化到模拟滚轮 / 翻页 / 滚动条。
    /// 顺序有讲究：`wheel_post_root` 只在「最深子窗口不处理滚轮」时才需要（Chrome 这类
    /// 自绘窗口的中间层子窗口就是这种情况），所以排在 wheel_input 之后当兜底。
    const METHOD_CANDIDATES: [ScrollMethod; 5] = [
        ScrollMethod::WheelPost,
        ScrollMethod::WheelInput,
        ScrollMethod::WheelPostRoot,
        ScrollMethod::PageDown,
        ScrollMethod::VScroll,
    ];
    // 挨个试方式时的诊断记录（失败时报给用户 + 写日志）。没有它，「该区域没有发生滚动」
    // 这句话对用户和对开发者都是死胡同：既不知道试了哪些方式，也不知道画面到底动没动。
    let mut tried: Vec<String> = Vec::new();
    let mut max_try_diff = 0.0f32;
    let mut best_try_shift = 0u32;
    // 首轮全部候选都没让画面动时，是否已经用「每步 2 格」重试过一遍
    let mut retry_used = false;
    // 已经证实「对这个目标无效」的注入方式（试错失败画面不会动，所以排除它们零代价）
    let mut dead_methods: Vec<ScrollMethod> = Vec::new();
    let canvas_w = cap.w;
    let params = MatchParams::for_height(cap.h);

    // 画面到底动没动：**必须以测得出连贯位移为准**，不能只看像素差异
    // （页面自身的动画/闪烁也能让 diff 变大，那会把方式误锁成可用）。
    let has_moved = |a: &RgbaImage, b: &RgbaImage| -> bool {
        match_frames(a, b, &params, None)
            .filter(|mm| mm.shift >= MIN_SHIFT)
            .is_some()
            || tolerant_shift(a, b)
                .filter(|(_, ratio)| *ratio < 0.8 && est_err_ok(a, b))
                .is_some()
    };
    // 选区高度被补足过 → 给用户一句说明（**长图宽度仍然是选区宽度**，只是纵向多捕获一些
    // 以保证相邻帧有足够重叠区；这是「框一小块也能长截图」的关键）
    let padded = cap.h > rect.h;

    {
        let mut p = ScrollCaptureProgress::bare("capturing", &cap);
        p.method = method.map(|m| m.name().to_string());
        p.input_passthrough = method == Some(ScrollMethod::WheelInput);
        p.message = Some(if padded {
            format!(
                "选区较矮，已自动把捕获高度补到 {}px 以保证拼接（长图宽度不变）",
                cap.h
            )
        } else {
            "开始滚动并拼接…".to_string()
        });
        on_progress(p.with_capture(&cap));
    }

    // ---- 3. 起始帧 ----
    frame_gate.borrow_mut().begin_frame();
    let first = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms);
    frame_gate.borrow_mut().end_frame();
    let first = first?;
    let mut canvas: Vec<u8> = Vec::with_capacity(cap.w as usize * cap.h as usize * 4 * 4);
    let mut canvas_h = 0u32;
    // 首帧：整帧入画布（无重叠）
    append_band(&mut canvas, canvas_w, &mut canvas_h, &first.image, 0, 0, 0)?;
    dlog.log(&format!(
        "first frame {}x{} settle={}ms polls={} timed_out={} cap={}x{} notches={} method={:?}",
        first.image.width(),
        first.image.height(),
        first.elapsed_ms,
        first.polls,
        first.timed_out,
        cap.w,
        cap.h,
        notches,
        method.map(|m| m.name())
    ));
    let mut preview = PreviewBuilder::new(canvas_w, PREVIEW_WIDTH);
    preview.append_strip(&first.image, 0);

    let mut prev = first.image;
    let mut frames = 1u32;
    // 还不知道「一格滚多少像素」（方式也是主循环里才定），所以第一步不设先验位移
    let mut last_shift: Option<u32> = None;
    let mut last_bottom_fixed = 0u32;
    // 起始帧入画时还没有固定栏信息；首次成功注册后再把它的吸底栏剔除。
    let mut initial_footer_pending = true;
    let mut failures = 0u32;
    let mut low_conf = false;
    let mut stop_reason: Option<String> = None;
    // 是否见过「确实动了、但位移小于 MIN_SHIFT」的帧。这是「已经到底/只剩几像素」
    // 的**观测证据**，与「所有注入方式都无效」是两回事，退出时要分开处理（见下方 match 分支）。
    let mut bottom_reached = false;

    {
        let mut p = ScrollCaptureProgress::bare("capturing", &cap);
        p.frames = frames;
        p.height = canvas_h;
        p.method = method.map(|m| m.name().to_string());
        p.input_passthrough = method == Some(ScrollMethod::WheelInput);
        p.preview = preview.data_url(PREVIEW_MAX_H);
        on_progress(p.with_capture(&cap));
    }

    // ---- 4. 主循环 ----
    while stop_reason.is_none() {
        if cancel.load(Ordering::Relaxed) {
            stop_reason = Some("已停止".to_string());
            break;
        }
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

        // 注入 + 稳定帧等待。**一律用补足后的捕获区**（`cap`）：选区宽度不变，
        // 但纵向留出了足够重叠区，矮选区也能拼。
        let frames_before = frames;
        // 方式未定时，按候选表挨个试；试错失败画面不会动，所以没有任何视觉代价
        let m = match method {
            Some(m) => m,
            None => {
                // 选下一个候选：跳过已知对本目标无效的方式；首轮全失败后把候选改用
                // 「每步 2 格」再试一遍 —— 1 格（40-50px）有可能小到指纹匹配测不出位移，
                // 看起来就像「根本没滚」。
                let mut pick: Vec<ScrollMethod> = METHOD_CANDIDATES
                    .into_iter()
                    .filter(|c| !dead_methods.contains(c))
                    .collect();
                if pick.is_empty() && !retry_used && o.notches.is_none() && !bottom_reached {
                    retry_used = true;
                    notches = notches.max(2);
                    pick = METHOD_CANDIDATES.to_vec();
                    tracing::info!("滚动截图: 全部候选未动，改用每步 {notches} 格重试一遍");
                }
                // 已经观测到「确实滚了、但位移 < MIN_SHIFT」（典型：启动时就在页面底部）：
                // 这时**不能**把候选表耗尽当成失败，否则「在底部开始」会被误报成「不可滚动」。
                // 直接按「到底」收尾，保留首帧内容，由下面「只截到一帧」的判定决定是
                // 正常结束（本来就只有一屏）还是报错。
                if pick.is_empty() && bottom_reached {
                    dlog.log("  位移过小且候选已试完 -> 判定已到底");
                    stop_reason = Some("已到达内容底部（滚动位移小于最小阈值）".to_string());
                    break;
                }
                let m = if pick.is_empty() {
                    // 所有注入方式都没能让画面产生可信位移。把「试过什么、画面到底动没动」
                    // 一并报出来：否则用户只能看到一句无从下手的「没有发生滚动」。
                    let deepest = deepest_child_at(cx, cy);
                    let deep_note = match deepest {
                        Some(h) if root_window(h) == root => {
                            "选区内最深的目标就是目标窗口本身".to_string()
                        }
                        Some(h) => format!(
                            "选区内最深的目标是 0x{h:X}（{}），滚轮消息发给了它",
                            window_info(hwnd_from(h))
                                .map(|w| format!("{} / {}", w.class, w.title))
                                .unwrap_or_else(|| "无法读取窗口信息".to_string())
                        ),
                        None => "选区内没找到目标窗口".to_string(),
                    };
                    let movement = if max_try_diff > SCROLLED_DIFF_RATIO {
                        format!(
                            "试的过程中画面确实在变（最大像素差异 {:.1}%）、但测不出可信的整体位移 —— \
                             典型的「亚像素滚动 / 周期性重绘 / 选区里在放视频动画」。",
                            max_try_diff * 100.0
                        )
                    } else if best_try_shift > 0 {
                        format!(
                            "测到的最大位移只有 {best_try_shift}px，小于 {MIN_SHIFT}px 的下限，\
                             可能是一次滚动幅度太小。"
                        )
                    } else {
                        "试的过程中画面完全没有变化。".to_string()
                    };
                    return Err(format!(
                        "该区域没有发生滚动（捕获区 {}×{}，选区 {}×{}）。\
                         已依次尝试：{}。{deep_note}。{movement}\
                         请确认：① 这块区域本身可以滚动（不是视频/固定布局）；\
                         ② 选区没有跨越两个滚动区域；③ 选区不要压在窗口标题栏/固定页头这类不滚动的地方。",
                        cap.w,
                        cap.h,
                        rect.w,
                        rect.h,
                        tried.join(" → "),
                    ));
                } else {
                    pick.remove(0)
                };
                m
            }
        };
        if method.is_none() {
            // 试 WheelInput 时覆盖窗要临时放行鼠标，否则滚轮会被我们自己的窗吃掉
            host.set_passthrough(m == ScrollMethod::WheelInput);
        }
        let injected = with_cursor_at(&cap, m, || inject_scroll(root, &cap, m, notches));
        if let Err(e) = injected {
            tried.push(format!("{}（注入失败：{e}）", m.name()));
            dead_methods.push(m);
            continue;
        }
        // 若等到超时还没稳定（Chrome 平滑滚动距离一长就要 1.5s+），别拿动画中间帧去匹配
        // ——那必然匹配失败。再给最多两轮机会。
        // 采帧期间（且仅当 HUD 压在捕获区上时）通知前端把 HUD 让开。
        frame_gate.borrow_mut().begin_frame();
        let settled = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms);
        frame_gate.borrow_mut().end_frame();
        let mut settled = settled?;
        let mut retries = 0;
        while settled.timed_out && retries < 2 {
            retries += 1;
            tracing::info!(
                "滚动截图: 帧{} 稳定等待超时（{}ms），再等一轮",
                frames,
                settled.elapsed_ms
            );
            frame_gate.borrow_mut().begin_frame();
            let retry = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms);
            frame_gate.borrow_mut().end_frame();
            settled = retry?;
        }
        let mut cur = settled.image;
        let diff = frame_diff_ratio(&prev, &cur);
        dlog.log(&format!(
            "frame{frames} inject={} notches={notches} settle={}ms timed_out={} diff={diff:.5} canvas_h={canvas_h}",
            m.name(),
            settled.elapsed_ms,
            settled.timed_out
        ));

        // ---- 方式还没定：用「这次到底动没动」来判定 ----
        // 注意：这里**不能**先做「两帧一致 = 到底」的判定 —— 还没滚起来时画面当然一致，
        // 会被误判成「已经到底」而直接结束。
        // 方式未定时，判定「这次到底动没动」**必须以「测得出连贯位移」为准**，
        // 不能只看像素差异：页面自身的动画/闪烁也能让 diff 变大（那会把方式误锁成可用，
        // 之后每一帧都匹配失败 → 一帧都拼不上，报「没有捕获到可拼接的内容」）。
        if method.is_none() {
            if !has_moved(&prev, &cur) {
                max_try_diff = max_try_diff.max(diff);
                if let Some(s) = tolerant_shift(&prev, &cur)
                    .filter(|(_, ratio)| *ratio < 0.8 && est_err_ok(&prev, &cur))
                    .map(|(s, _)| s)
                {
                    best_try_shift = best_try_shift.max(s);
                }
                dead_methods.push(m);
                tried.push(format!("{}（差异 {:.1}%）", m.name(), diff * 100.0));
                tracing::info!(
                    "滚动截图: 方式 {} 无效（diff={:.4}），换下一个",
                    m.name(),
                    diff
                );
                prev = cur;
                continue;
            }
            // 定下来了：这一次注入本身就是**第一帧真实内容**，不浪费
            method = Some(m);
            if wheel_like(m) {
                // 顺手标定「一格滚多少像素」，用于后续每步的格数（这一步只用了 1 格）
                if let Some(mm) =
                    match_frames(&prev, &cur, &params, None).filter(|mm| mm.shift >= MIN_SHIFT)
                {
                    let usable_h = cap
                        .h
                        .saturating_sub(mm.top_fixed)
                        .saturating_sub(mm.bottom_fixed);
                    if mm.shift + params.min_overlap >= usable_h {
                        return Err(format!(
                            "选区太矮：一次滚动约 {}px，扣除 {}px 固定区域后正文只有 {}px，\
                             不足以保留 {}px 的最小重叠区，无法拼接。\
                             请把选区拉高到 {}px 以上，或在更大的窗口里重新框选。",
                            mm.shift,
                            mm.top_fixed + mm.bottom_fixed,
                            usable_h,
                            params.min_overlap,
                            mm.shift + mm.top_fixed + mm.bottom_fixed + params.min_overlap + 16
                        ));
                    }
                    if o.notches.is_none() {
                        let target = (cap.h as f32 * 0.4) as u32;
                        notches = (target / mm.shift.max(1)).clamp(1, 40);
                        // 标定把「每步位移」从 1 格放大到 notches 格，`last_shift` 是**旧尺度**的
                        // 先验。`match_frames` 只在 [prior/4, prior*4] 里找候选，尺度一变就可能
                        // 把所有正确候选都筛掉、退回保守的 peak 位移，于是每步少追加一大截
                        // （帧数暴涨、还容易触发「高度上限」提前收兵）。所以标定后清掉先验，
                        // 让下一帧重新自由匹配一次。
                        last_shift = None;
                    }
                }
            }
            tracing::info!(
                "滚动截图: 注入方式={}（主循环试出）每步={}格 捕获区={}x{}（选区 {}x{}）",
                m.name(),
                notches,
                cap.w,
                cap.h,
                rect.w,
                rect.h
            );
            let mut p = ScrollCaptureProgress::bare("capturing", &cap);
            p.frames = frames;
            p.height = canvas_h;
            p.method = Some(m.name().to_string());
            p.input_passthrough = m == ScrollMethod::WheelInput;
            p.message = Some(format!("注入方式 {}（每步 {notches} 格）", m.name()));
            p.preview = preview.data_url(PREVIEW_MAX_H);
            on_progress(p.with_capture(&cap));
        }

        // 与上一帧完全一致 → 再等一轮确认，仍一致就是到底了
        if diff <= SAME_FRAME_RATIO {
            std::thread::sleep(Duration::from_millis(o.settle_timeout_ms.min(1200)));
            frame_gate.borrow_mut().begin_frame();
            let again = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms);
            frame_gate.borrow_mut().end_frame();
            let again = again?.image;
            if frame_diff_ratio(&cur, &again) <= SAME_FRAME_RATIO {
                tracing::info!("滚动截图: 帧{frames} 画面不再变化 → 判定到底");
                break; // 正常到底
            }
            cur = again;
        }

        let matched = match_frames(&prev, &cur, &params, last_shift);
        tracing::info!(
            "滚动截图: 帧{} diff={:.4} 匹配={:?}",
            frames,
            diff,
            matched.map(|m| (m.shift, m.run, m.top_fixed, m.bottom_fixed, m.ambiguous))
        );
        dlog.log(&format!(
            "  match={:?} min_overlap={} last_shift={:?} failures={failures}",
            matched.map(|m| (
                m.shift,
                m.run,
                m.top_fixed,
                m.bottom_fixed,
                m.ambiguous,
                m.runner_up,
                m.block_inlier_ratio,
                m.mean_block_error,
                m.runner_up_gap,
            )),
            params.min_overlap,
            last_shift
        ));
        match matched {
            Some(m) if m.shift >= MIN_SHIFT => {
                if initial_footer_pending {
                    if trim_initial_footer(&mut canvas, canvas_w, &mut canvas_h, m.bottom_fixed) {
                        // 预览也必须和画布保持同一不变量，否则结果虽正确、缩略图却仍会在
                        // 中间显示一次首帧页脚。
                        if let Some(body) = RgbaImage::from_raw(canvas_w, canvas_h, canvas.clone())
                        {
                            preview = PreviewBuilder::new(canvas_w, PREVIEW_WIDTH);
                            preview.append_strip(&body, 0);
                        }
                        dlog.log(&format!(
                            "  首帧吸底栏 {}px 已剔除，canvas_h={canvas_h}",
                            m.bottom_fixed
                        ));
                    }
                    initial_footer_pending = false;
                }
                // 本帧正文里的新内容：正文区最后 shift 行（画布只存 页头+正文，见 append_band）
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
                // 内容重复率仅用于诊断：白底、段落留白、表格行等都会让它很高，不能再
                // 把它当成拼接正确性的证据或结果置信度。
                let dup = duplicate_ratio(
                    &canvas,
                    canvas_w,
                    canvas_h,
                    &cur,
                    append_from,
                    cur.height().saturating_sub(m.bottom_fixed),
                );
                dlog.log(&format!(
                    "  append? shift={} header={} footer={} append_from={append_from} net={net} new_h={new_h} duplicate_diagnostic={dup:.3} support={:.3} error={:.2} gap={:.3} canvas_h={canvas_h}",
                    m.shift, m.top_fixed, m.bottom_fixed, m.block_inlier_ratio, m.mean_block_error, m.runner_up_gap
                ));
                let overlap = cur.height().saturating_sub(m.shift);
                let weak = m.ambiguous
                    || (m.run as u64) * 2 < overlap as u64
                    || m.block_inlier_ratio < 0.75
                    || m.mean_block_error > 12.0
                    || (m.runner_up.is_some() && m.runner_up_gap < 0.08);
                if new_h as u64 * canvas_w as u64 * 4 > MAX_CANVAS_BYTES {
                    stop_reason = Some("结果过大（内存上限），已保留当前结果".to_string());
                } else {
                    if dup > 0.6 {
                        tracing::info!(
                            "滚动截图: 帧{} 内容重复诊断 {:.0}%（不影响配准置信度；support={:.0}% error={:.1} gap={:.0}%）",
                            frames,
                            dup * 100.0,
                            m.block_inlier_ratio * 100.0,
                            m.mean_block_error,
                            m.runner_up_gap * 100.0,
                        );
                    }
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
                    failures = 0;
                    if weak {
                        low_conf = true;
                    }
                    dlog.log(&format!(
                        "  -> 追加成功 frames={frames} canvas_h={canvas_h} 净增={net} low_conf={low_conf}"
                    ));
                }
            }
            Some(mm) if mm.shift > 0 => {
                // 位移太小（但确实动了）：可能是「到底了」，也可能是**当前这种注入方式对这个
                // 目标突然失效**（典型：页面里先滚外层、再滚到内层侧栏，或者切了路由/换了滚动
                // 容器）。早期直接 break 当作正常到底，于是用户看到「滚动截图完成」却只截到一屏。
                // 现在改成：只要还有没试过的注入方式，就退回「挨个试」再找一种。
                bottom_reached = true;
                let has_untried = METHOD_CANDIDATES.iter().any(|c| !dead_methods.contains(c));
                if has_untried {
                    tracing::info!(
                        "滚动截图: 帧{frames} 位移过小（{}px），换一种注入方式再试（当前 {}）",
                        mm.shift,
                        m.name()
                    );
                    dlog.log(&format!(
                        "  shift {} < MIN_SHIFT -> 换注入方式重探测",
                        mm.shift
                    ));
                    dead_methods.push(m);
                    method = None;
                    last_shift = None;
                    prev = cur;
                    continue;
                }
                // ⚠ 候选**全部试完**时不能再把那句「该区域没有发生滚动」当成结论：这里明明
                // 观测到了滚动（只是幅度小于 MIN_SHIFT），最常见的成因就是已经在页面底部。
                // 早期实现会在下一次循环走进「候选为空 → return Err(...没有发生滚动...)」，
                // 于是「在底部启动」被误报成「这块区域不可滚动」（用户侧看起来像功能坏了）。
                break;
            }
            Some(_) => {
                // 位移为 0：怎么滚都不动，就是到底了
                break;
            }
            None => {
                // 匹配失败。两种可能：
                // (a) 这个目标的渲染不是像素级可复现（亚像素滚动重绘、文字抗锯齿抖动）
                //     → 用容差 SAD 兜底拼上，标记低置信；
                // (b) 真的拼不上（动画、画面跳变）→ 用上一步位移当 best-guess 继续；
                //     连续失败多次就收兵，保留已拼接部分。
                let tolerant = tolerant_shift(&prev, &cur)
                    .filter(|(_, ratio)| *ratio < 0.8 && est_err_ok(&prev, &cur));
                if let Some((shift, _ratio)) = tolerant {
                    // 下标换算必须与 `append_band` 的约定一致（画布只存 页头+正文，
                    // 吸底栏由收尾贴一次）：本帧正文里最新的是 shift 行、且位于吸底栏**之上**，
                    // 所以追加区结束于 `h - last_bottom_fixed`，起点是 `h - last_bottom_fixed - shift`。
                    // ⚠ 早期这里写成 `h - shift`（把吸底栏也算进新内容），于是预览条带比画布实际
                    // 追加的内容**偏移了一个页脚高度**（缩略图与长图对不上）。
                    let footer_h = last_bottom_fixed.min(cur.height().saturating_sub(1));
                    let shift = shift.min(cur.height().saturating_sub(footer_h).saturating_sub(1));
                    let append_from = cur.height().saturating_sub(footer_h).saturating_sub(shift);
                    let net = cur.height().saturating_sub(footer_h) - append_from;
                    let _ = append_band(
                        &mut canvas,
                        canvas_w,
                        &mut canvas_h,
                        &cur,
                        0,
                        footer_h,
                        shift,
                    );
                    if net > 0 {
                        let strip = image::imageops::crop_imm(&cur, 0, append_from, canvas_w, net)
                            .to_image();
                        preview.append_strip(&strip, canvas_h - net);
                    }
                    frames += 1;
                    last_shift = Some(shift);
                    failures = 0;
                    low_conf = true;
                } else {
                    failures += 1;
                    low_conf = true;
                    if let Some(guess) = last_shift.filter(|g| *g >= MIN_SHIFT && *g < cur.height())
                    {
                        let _ = append_band(
                            &mut canvas,
                            canvas_w,
                            &mut canvas_h,
                            &cur,
                            0,
                            last_bottom_fixed,
                            guess,
                        );
                        frames += 1;
                    }
                    if failures >= MAX_MATCH_FAILURES {
                        stop_reason = Some(
                            "连续多帧无法匹配（内容可能有动画或大面积重复），已保留当前结果"
                                .to_string(),
                        );
                    }
                }
            }
        }

        prev = cur;

        // 进度事件（含缩略预览）。本帧没追加成功时不要报「匹配成功」，
        // 否则前端会看到一串「帧数不变」的进度、以为卡住了。
        let progressed = frames > frames_before;
        let mut p =
            ScrollCaptureProgress::bare(if progressed { "matched" } else { "capturing" }, &cap);
        p.frames = frames;
        p.height = canvas_h;
        p.width = canvas_w;
        p.method = method.map(|m| m.name().to_string());
        p.input_passthrough = method == Some(ScrollMethod::WheelInput);
        if low_conf {
            p.stage = "low_confidence".to_string();
            p.message =
                Some("部分帧的位移配准证据不足（可能有动画、固定控件或重复布局）".to_string());
        }
        p.preview = preview.data_url(PREVIEW_MAX_H);
        on_progress(p.with_capture(&cap));
        // 任务栏进度：全屏/整窗选区时覆盖窗里没空地放 HUD，这里是唯一始终可见的反馈
        host.set_progress(true, canvas_h as f32 / o.max_height_px.max(1) as f32);

        if let Some(reason) = stop_reason.clone() {
            let _ = reason;
            break;
        }
    }

    // 正常收尾：立刻还原宿主（幂等；即使这里不写，`session_cleanup` 的 Drop 也会兜底）
    session_cleanup.host.set_escape_hook(false);
    session_cleanup.host.set_passthrough(false);
    // 结束时清掉任务栏进度（成功/失败/取消都要走到这里）
    session_cleanup.host.set_progress(false, 0.0);
    // 会话结束：任何路径都不能把前端 HUD 留在「采帧隐藏」态
    session_cleanup.gate.borrow_mut().restore();

    // ---- 5. 收尾 ----
    // 画布只存「页头 + 累积正文」（见 append_band 的约定），这里把最后一帧的吸底栏贴上，
    // 于是它整张长图只出现一次。
    attach_footer(
        &mut canvas,
        canvas_w,
        &mut canvas_h,
        &prev,
        last_bottom_fixed,
    );
    if canvas_h <= cap.h.saturating_sub(last_bottom_fixed) {
        // 只截到一帧：说明根本没滚动起来（画布只含 页头+正文，所以拿「一帧的正文高」比）
        dlog.log(&format!(
            "FAIL 只有一帧 canvas_h={canvas_h} cap.h={} footer={last_bottom_fixed} frames={frames} tried={tried:?} dead={:?}",
            cap.h,
            dead_methods.iter().map(|m| m.name()).collect::<Vec<_>>()
        ));
        return Err("没有捕获到可拼接的内容（目标区域可能不可滚动）".to_string());
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
        message: stop_reason.clone(),
        png,
    };

    let mut p = ScrollCaptureProgress::bare(
        if result.confidence == "partial" {
            "partial"
        } else {
            "done"
        },
        &rect,
    );
    dlog.log(&format!(
        "OK {}x{} frames={frames} confidence={confidence} method={:?} notches={notches} stop={:?}",
        result.width,
        result.height,
        method.map(|m| m.name()),
        result.message
    ));
    p.frames = result.frames;
    p.width = result.width;
    p.height = result.height;
    p.method = method.map(|m| m.name().to_string());
    p.input_passthrough = false;
    p.message = result.message.clone();
    p.preview = preview.data_url(PREVIEW_MAX_H);
    on_progress(p.with_capture(&cap));

    Ok(result)
}

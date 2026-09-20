use image::RgbaImage;

use super::{frame_shift, grayscale, ShiftEstimate};

pub(crate) const MIN_SHIFT: u32 = 4;

// ---------- 纵向位移估计（P0 的粗糙版，P1 会被行指纹匹配取代） ----------

/// SAD 核心：在给定的灰度行图上找最佳位移
/// 估计「内容向上移动了多少像素」。
///
/// 仅用于采集「一格滚轮实际滚多少像素」这种标定信息，**不参与最终拼接**
/// （含吸顶/吸底固定区域的页面会让朴素 SAD 失准，正式匹配见方案第 5 节）。
pub fn estimate_shift(prev: &RgbaImage, cur: &RgbaImage) -> Option<ShiftEstimate> {
    if prev.dimensions() != cur.dimensions() {
        return None;
    }
    let (_w, h) = prev.dimensions();
    let (gp, gw, _gh) = grayscale::downsample(prev, 96);
    let (gc, _cw, _ch) = grayscale::downsample(cur, 96);
    frame_shift::from_grays(&gp, &gc, gw as usize, h)
}

/// 粗测哪些横向分段是「不随滚动移动的固定区域」（资源管理器导航窗格、VS Code 侧栏…）。
/// 采样比对，成本很低；返回每个分段的 (x0, x1, 是否移动)。
fn detect_moving_segments(prev: &RgbaImage, cur: &RgbaImage) -> Vec<(u32, u32, bool)> {
    let (w, h) = cur.dimensions();
    let side = (w / 20).max(50).min(w / 3);
    let (x0, x1) = (side, w.saturating_sub(side));
    let seg_w = ((x1.saturating_sub(x0)).max(1) / FP_SEGMENTS).max(1);
    let mut out = Vec::with_capacity(FP_SEGMENTS as usize);
    for k in 0..FP_SEGMENTS {
        let sx0 = (x0 + k * seg_w).min(w.saturating_sub(1));
        let sx1 = if k + 1 == FP_SEGMENTS {
            x1
        } else {
            (sx0 + seg_w).min(x1)
        };
        let sx1 = sx1.max(sx0 + 1);
        let mut same = 0u32;
        let mut total = 0u32;
        let mut y = 0;
        while y < h {
            let mut x = sx0;
            while x < sx1 {
                if prev.get_pixel(x, y) == cur.get_pixel(x, y) {
                    same += 1;
                }
                total += 1;
                x += 8;
            }
            y += 8;
        }
        let frac = if total == 0 {
            1.0
        } else {
            same as f32 / total as f32
        };
        out.push((sx0, sx1, frac < 0.6));
    }
    out
}

/// 容差版位移测量：用块平均灰度的 SAD 找最佳位移。
///
/// 当**指纹匹配失败**（说明该目标的渲染不是像素级可复现：亚像素滚动重绘、
/// 文本抗锯齿抖动等）时兜底使用。**只在「会移动」的横向分段上算**——
/// 固定侧栏在 SAD 里是纯噪声，会把真正的对齐信号淹掉（资源管理器就是这么栽的）。
pub fn tolerant_shift(prev: &RgbaImage, cur: &RgbaImage) -> Option<(u32, f32)> {
    if prev.dimensions() != cur.dimensions() {
        return None;
    }
    let (_w, h) = prev.dimensions();
    let segs = detect_moving_segments(prev, cur);
    let moving: Vec<(u32, u32)> = segs
        .iter()
        .filter(|(_, _, m)| *m)
        .map(|(a, b, _)| (*a, *b))
        .collect();
    let est = if moving.is_empty() || moving.len() == segs.len() {
        estimate_shift(prev, cur)?
    } else {
        let (gp, gw, _gh) = gray_masked(prev, &moving, 96);
        let (gc, _cw, _ch) = gray_masked(cur, &moving, 96);
        frame_shift::from_grays(&gp, &gc, gw as usize, h)?
    };
    if est.shift < MIN_SHIFT || est.err_at_zero <= f32::EPSILON {
        return None;
    }
    let ratio = est.err / est.err_at_zero;
    Some((est.shift, ratio))
}

/// 只在给定列区间上做块平均灰度降采样（区间并排拼接后降采样）
fn gray_masked(img: &RgbaImage, ranges: &[(u32, u32)], target_w: u32) -> (Vec<u8>, u32, u32) {
    let (w, h) = img.dimensions();
    let total_cols: u32 = ranges.iter().map(|(a, b)| b.saturating_sub(*a)).sum();
    if total_cols == 0 {
        return (Vec::new(), 0, 0);
    }
    let step_x = (total_cols / target_w.max(1)).max(1);
    let out_w = (total_cols / step_x).max(1);
    let raw = img.as_raw();
    let taps = step_x.clamp(1, 4);
    let tap_step = (step_x / taps).max(1);
    let mut out = Vec::with_capacity((out_w * h) as usize);
    for y in 0..h {
        let base = y as usize * w as usize * 4;
        for ox in 0..out_w {
            let mut col = ox * step_x;
            let mut sum = 0u32;
            let mut n = 0u32;
            for _ in 0..taps {
                // 把拼接后的列号映射回原图列号
                let mut c = col;
                let mut x = 0u32;
                for (a, b) in ranges {
                    let span = b.saturating_sub(*a);
                    if c < span {
                        x = a + c;
                        break;
                    }
                    c -= span;
                }
                let x = x.min(w - 1);
                let i = base + x as usize * 4;
                sum += (299 * raw[i] as u32 + 587 * raw[i + 1] as u32 + 114 * raw[i + 2] as u32)
                    / 1000;
                n += 1;
                col += tap_step;
            }
            out.push(sum.checked_div(n).unwrap_or(0) as u8);
        }
    }
    (out, out_w, h)
}

// P1：纵向拼接
// ============================================================

/// 匹配参数
#[derive(Debug, Clone, Copy)]
pub struct MatchParams {
    /// 认定的最小重叠行数：短于此视为匹配失败
    pub min_overlap: u32,
    /// 行指纹的采样列步长（每 N 列取 1 个样本）
    pub fp_step: u32,
}

impl MatchParams {
    pub fn for_height(h: u32) -> Self {
        Self {
            min_overlap: (h / 10).clamp(16, 240),
            fp_step: 4,
        }
    }
}

/// 两帧之间的纵向匹配结果
#[derive(Debug, Clone, Copy)]
pub struct MatchResult {
    /// 位移：这一帧页面往上滚了多少物理像素
    pub shift: u32,
    /// 该位移下最长连续匹配行数（置信度的直接来源）
    pub run: u32,
    /// 顶部固定带高度（吸顶导航/标题栏：两帧在同一位置完全相同）
    pub top_fixed: u32,
    /// 底部固定带高度（吸底工具栏/输入框：两帧在同一位置完全相同）
    pub bottom_fixed: u32,
    /// 是否存在另一个同样可信、但位移明显不同的候选（周期性内容歧义）
    pub ambiguous: bool,
    /// 次优候选位移（诊断用）
    pub runner_up: Option<u32>,
    /// 在动态安全区内支持该位移的图像块比例（0-1）
    pub block_inlier_ratio: f32,
    /// 动态安全区内的平均像素残差（0-255，越小越好）
    pub mean_block_error: f32,
    /// 最优位移相对次优位移的残差优势（0-1，越大越可区分）
    pub runner_up_gap: f32,
}

/// 行指纹：把一行的采样列量化后哈希成 64 位。
///
/// 量化（每通道 `>>3`，即 5 bit）是为了吸收极少量非确定性渲染差异（次像素抗锯齿、
/// GPU 取整抖动等），又不至于把不同内容混同。
fn row_fingerprints(img: &RgbaImage, x0: u32, x1: u32, step: u32) -> Vec<u64> {
    let (w, h) = img.dimensions();
    let raw = img.as_raw();
    let mut out = Vec::with_capacity(h as usize);
    let step = step.max(1);
    for y in 0..h {
        let base = y as usize * w as usize * 4;
        let mut hsh: u64 = 0xcbf2_9ce4_8422_2325;
        let mut x = x0;
        while x < x1 {
            let i = base + x as usize * 4;
            let packed = ((raw[i] >> 3) as u64) << 10
                | ((raw[i + 1] >> 3) as u64) << 5
                | (raw[i + 2] >> 3) as u64;
            hsh = (hsh ^ packed).wrapping_mul(0x0000_0100_0000_01b3);
            x += step;
        }
        out.push(hsh);
    }
    out
}

/// 横向切成几段做指纹
const FP_SEGMENTS: u32 = 5;

/// 分段行指纹网格。
///
/// **为什么要分段**：真实应用里经常存在**不随滚动移动的区域**——资源管理器的导航窗格、
/// VS Code 的侧边栏、网页的固定侧栏。整行只算一个指纹时，只要行内有一段是静止的，
/// 这一行就永远对不上，长重叠区根本跑不出来（P1 实测：资源管理器会话直接被判「滚不动」）。
///
/// **为什么不能只做「多数段相同」**：那样会让错误的位移也能过 —— 等距同款列表里
/// 相邻行只有行号不同，多数段照样相同，于是「滚了 3 行」会被认成「滚了 1 行」
/// （P1 实测：ListBox 会话每步只前进 1/3 的内容，跑满 200 帧上限）。
///
/// 现在的规则：先按「两帧在同一行下标处是否相同」把**整段静止的段**识别出来并忽略，
/// 其余段必须**全部严格相同**才算这一行匹配。既有固定侧栏也不会僵死，又保留了
/// 「行号不同就不算匹配」的判别力。
struct FpGrid {
    segs: Vec<Vec<u64>>,
    /// 该段是否随滚动移动（false = 固定区域，不参与匹配）
    moving: Vec<bool>,
    /// 是否存在固定段（用于诊断）
    has_static: bool,
}

impl FpGrid {
    /// 同时构建两帧的网格，并让它们共享同一份 `moving` 判据
    fn pair(
        prev: &RgbaImage,
        cur: &RgbaImage,
        x0: u32,
        x1: u32,
        step: u32,
        segments: u32,
    ) -> (Self, Self) {
        let segments = segments.max(1);
        let span = x1.saturating_sub(x0).max(1);
        let seg_w = (span / segments).max(1);
        let h = cur.height().min(prev.height()) as usize;
        let mut segs_prev = Vec::with_capacity(segments as usize);
        let mut segs_cur = Vec::with_capacity(segments as usize);
        let mut moving = Vec::with_capacity(segments as usize);
        for k in 0..segments {
            let sx0 = (x0 + k * seg_w).min(cur.width().saturating_sub(1));
            let sx1 = if k + 1 == segments {
                x1
            } else {
                (sx0 + seg_w).min(x1)
            };
            let sx1 = sx1.max(sx0 + 1).min(cur.width());
            let fp_prev = row_fingerprints(prev, sx0, sx1, step);
            let fp_cur = row_fingerprints(cur, sx0, sx1, step);
            // 「同一行下标处相同」的比例高 = 这一段整体没动（固定区域）
            let same = (0..h).filter(|y| fp_prev[*y] == fp_cur[*y]).count();
            let frac = if h == 0 { 1.0 } else { same as f32 / h as f32 };
            moving.push(frac < 0.5);
            segs_prev.push(fp_prev);
            segs_cur.push(fp_cur);
        }
        // 全段静止说明两帧几乎一致（调用方另有「到底」判定），此时退回全段参与匹配
        let has_static = moving.iter().any(|m| !*m);
        if !moving.iter().any(|m| *m) {
            moving.iter_mut().for_each(|m| *m = true);
        }
        (
            Self {
                segs: segs_prev,
                moving: moving.clone(),
                has_static,
            },
            Self {
                segs: segs_cur,
                moving,
                has_static,
            },
        )
    }

    /// `self[cur_y]` 与 `other[prev_y]` 是否算「同一行内容」：
    /// **所有移动段都必须严格相同**（固定段不参与）
    #[inline]
    fn row_match(&self, other: &FpGrid, cur_y: usize, prev_y: usize) -> bool {
        for k in 0..self.segs.len() {
            if !self.moving[k] {
                continue;
            }
            if self.segs[k][cur_y] != other.segs[k][prev_y] {
                return false;
            }
        }
        true
    }

    /// 同一位置（用于识别吸顶/吸底固定带）
    #[inline]
    fn same_row(&self, other: &FpGrid, y: usize) -> bool {
        self.row_match(other, y, y)
    }
}

/// 对行指纹给出的候选位移做一次容差像素复核。
///
/// 行指纹只负责快速找候选；置信度应来自真实重叠区有多少小块支持这个位移，
/// 而不是新追加内容是否恰好和旧内容里某些空白行相同。固定页头/页脚与左右边缘
/// 均不参与，以形成用于注册的动态安全区。
fn block_registration_quality(
    prev: &RgbaImage,
    cur: &RgbaImage,
    side: u32,
    top_fixed: u32,
    bottom_fixed: u32,
    shift: u32,
) -> (f32, f32) {
    let (w, h) = cur.dimensions();
    let y0 = top_fixed.min(h);
    let y1 = h.saturating_sub(bottom_fixed).saturating_sub(shift);
    let x0 = side.min(w);
    let x1 = w.saturating_sub(side);
    if y1 <= y0 || x1 <= x0 {
        return (0.0, f32::INFINITY);
    }

    const BLOCK_H: u32 = 24;
    const SAMPLE_X: u32 = 8;
    const SAMPLE_Y: u32 = 4;
    const INLIER_ERROR: f32 = 10.0;
    let a = prev.as_raw();
    let b = cur.as_raw();
    let mut blocks = 0u32;
    let mut inliers = 0u32;
    let mut error_sum = 0.0f32;

    let mut by = y0;
    while by < y1 {
        let by_end = (by + BLOCK_H).min(y1);
        let mut sum = 0u64;
        let mut samples = 0u64;
        let mut y = by;
        while y < by_end {
            let mut x = x0;
            while x < x1 {
                let ci = ((y * w + x) * 4) as usize;
                let pi = (((y + shift) * w + x) * 4) as usize;
                sum += (b[ci] as i16 - a[pi] as i16).unsigned_abs() as u64;
                sum += (b[ci + 1] as i16 - a[pi + 1] as i16).unsigned_abs() as u64;
                sum += (b[ci + 2] as i16 - a[pi + 2] as i16).unsigned_abs() as u64;
                samples += 3;
                x += SAMPLE_X;
            }
            y += SAMPLE_Y;
        }
        if samples > 0 {
            let error = sum as f32 / samples as f32;
            error_sum += error;
            blocks += 1;
            if error <= INLIER_ERROR {
                inliers += 1;
            }
        }
        by = by_end;
    }
    if blocks == 0 {
        (0.0, f32::INFINITY)
    } else {
        (inliers as f32 / blocks as f32, error_sum / blocks as f32)
    }
}

/// 在 `prev` / `cur` 之间找纵向位移（= 这一帧页面往上滚了多少像素）。
///
/// `prior_shift` 是上一步（或探针）测得的位移，用来在**周期性内容**造成的多解里挑最合理的
/// 那个：滚动步长是稳定的，所以「离上一步最近的可信候选」几乎总是正确答案。
///
/// 返回 `None` = 没有可信匹配（画面跳变、动态内容、纯色区域等）。
pub fn match_frames(
    prev: &RgbaImage,
    cur: &RgbaImage,
    params: &MatchParams,
    prior_shift: Option<u32>,
) -> Option<MatchResult> {
    let (w, h) = cur.dimensions();
    if prev.dimensions() != cur.dimensions() || h < 16 || w < 16 {
        return None;
    }
    // 左右各忽略一部分（躲滚动条/边框/侧边栏）——P0/ShareX 一致的做法
    let side = (w / 20).max(50).min(w / 3);
    let (x0, x1) = (side, w.saturating_sub(side));
    if x1 <= x0 + 8 {
        return None;
    }
    let (fp_prev, fp_cur) = FpGrid::pair(prev, cur, x0, x1, params.fp_step, FP_SEGMENTS);

    // 顶部/底部固定带（同位置行指纹相同的最长前缀/后缀）
    let cap = h / 3;
    let mut top_fixed = 0u32;
    while top_fixed < cap && fp_cur.same_row(&fp_prev, top_fixed as usize) {
        top_fixed += 1;
    }
    let mut bottom_fixed = 0u32;
    while bottom_fixed < cap
        && bottom_fixed < h - 1
        && fp_cur.same_row(&fp_prev, (h - 1 - bottom_fixed) as usize)
    {
        bottom_fixed += 1;
    }

    // 候选位移：s ∈ [1, h - bottom_fixed - min_overlap]
    let s_max = h
        .saturating_sub(bottom_fixed)
        .saturating_sub(params.min_overlap);
    if s_max < 1 {
        return None;
    }
    let mut cands: Vec<(u32, u32)> = Vec::new(); // (shift, longest_run)
    for s in 1..=s_max {
        let n = h - bottom_fixed - s; // 重叠行数
        let mut run = 0u32;
        let mut best_run = 0u32;
        for y in 0..n {
            if fp_cur.row_match(&fp_prev, y as usize, (y + s) as usize) {
                run += 1;
                if run > best_run {
                    best_run = run;
                }
            } else {
                run = 0;
            }
        }
        if best_run >= params.min_overlap {
            cands.push((s, best_run));
        }
    }
    if cands.is_empty() {
        return None;
    }

    let best_run = cands.iter().map(|(_, r)| *r).max().unwrap_or(0);
    // 峰值候选（最长连续匹配；周期内容下会偏向最小可行位移 = 保守：宁可少追加也不重复内容）
    let peak = *cands
        .iter()
        .max_by_key(|(s, r)| (*r, std::cmp::Reverse(*s)))
        .map(|(s, _)| s)
        .unwrap_or(&cands[0].0);

    let chosen = match prior_shift.filter(|p| *p >= MIN_SHIFT) {
        // 有先验（上一步/探针测得的位移）：在合理范围里挑**离先验最近**的候选。
        // 这一步是周期性内容能不能拼对的关键：等距同款列表里 s 与 s±k·period 全都「对得上」，
        // 只有先验能区分；而「最长 run」永远偏向最小位移，会把位移越拼越小。
        Some(prior) => cands
            .iter()
            .filter(|(s, _)| *s <= prior.saturating_mul(4).max(MIN_SHIFT) && *s * 4 >= prior)
            .min_by_key(|(s, r)| (s.abs_diff(prior), std::cmp::Reverse(*r)))
            .map(|(s, _)| *s)
            .unwrap_or(peak),
        None => peak,
    };

    let mut contenders: Vec<(u32, u32)> = cands
        .iter()
        .copied()
        .filter(|(_, r)| (*r as f32) >= best_run as f32 * 0.85)
        .collect();
    contenders.sort_by_key(|(s, _)| *s);

    let chosen_run = cands
        .iter()
        .find(|(s, _)| *s == chosen)
        .map(|(_, r)| *r)
        .unwrap_or(best_run);
    let spread = contenders
        .iter()
        .map(|(s, _)| *s)
        .max()
        .unwrap_or(0)
        .saturating_sub(contenders.iter().map(|(s, _)| *s).min().unwrap_or(0));
    // 判歧义：存在另一个同样可信、但位移差得够远的候选。
    // 阈值取 max(24px, 最佳位移的 10%)：周期性内容（等距同款列表）正是这种情形。
    let ambiguous = contenders.len() > 1 && spread > (chosen / 10).max(24);
    let runner_up = contenders
        .iter()
        .filter(|(s, _)| *s != chosen)
        .max_by_key(|(_, r)| *r)
        .map(|(s, _)| *s);
    let (block_inlier_ratio, mean_block_error) =
        block_registration_quality(prev, cur, side, top_fixed, bottom_fixed, chosen);
    let runner_up_gap = runner_up
        .map(|s| {
            let (_, runner_error) =
                block_registration_quality(prev, cur, side, top_fixed, bottom_fixed, s);
            if !runner_error.is_finite() {
                1.0
            } else {
                (runner_error - mean_block_error).max(0.0) / runner_error.max(1.0)
            }
        })
        .unwrap_or(1.0);

    Some(MatchResult {
        shift: chosen,
        run: chosen_run,
        top_fixed,
        bottom_fixed,
        ambiguous,
        runner_up,
        block_inlier_ratio,
        mean_block_error,
        runner_up_gap,
    })
}

// ============================================================

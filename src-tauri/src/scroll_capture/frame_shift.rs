//! 帧间位移估计的数据模型。

/// 两帧之间的纵向位移估计。
#[derive(Debug, Clone, Copy)]
pub struct ShiftEstimate {
    /// 正数表示内容向上移动（即页面向下滚动）。
    pub shift: u32,
    /// 该位移下的平均灰度误差。
    pub err: f32,
    /// 零位移下的平均灰度误差，用作对照。
    pub err_at_zero: f32,
}

impl ShiftEstimate {
    /// 相对「把两帧视为未位移」的误差改进幅度。
    pub fn improvement(&self) -> f32 {
        if self.err <= f32::EPSILON {
            f32::INFINITY
        } else {
            self.err_at_zero / self.err
        }
    }
}

/// 找出采样灰度绝对误差最小的纵向位移。
pub(super) fn from_grays(
    previous: &[u8],
    current: &[u8],
    width: usize,
    height: u32,
) -> Option<ShiftEstimate> {
    if width == 0 || height < 32 {
        return None;
    }
    let margin = (width / 20).max(1);
    let x0 = margin;
    let x1 = width.saturating_sub(margin).max(x0 + 1);
    let height = height as usize;
    // PageDown 与触控板惯性滑动可能远超半个视口。这里只保留配准所需的
    // 最小重叠，而不是把这类有效帧直接判成「无位移」。
    let min_overlap = (height / 10).clamp(32, 240);
    let max_shift = height.saturating_sub(min_overlap).max(1);
    let rows: Vec<usize> = (0..height).step_by(2).collect();
    let score = |shift: usize| {
        let mut sum = 0u64;
        let mut samples = 0u64;
        for &y in &rows {
            let previous_y = y + shift;
            if previous_y >= height {
                break;
            }
            let a = &current[y * width + x0..y * width + x1];
            let b = &previous[previous_y * width + x0..previous_y * width + x1];
            for (index, value) in a.iter().enumerate() {
                sum += (*value as i32 - b[index] as i32).unsigned_abs() as u64;
                samples += 1;
            }
        }
        if samples == 0 {
            f32::MAX
        } else {
            sum as f32 / samples as f32
        }
    };

    let zero_error = score(0);
    let mut best = (0usize, zero_error);
    for shift in 1..=max_shift {
        let error = score(shift);
        if error < best.1 {
            best = (shift, error);
        }
        if error < 0.4 {
            break;
        }
    }
    Some(ShiftEstimate {
        shift: best.0 as u32,
        err: best.1,
        err_at_zero: zero_error,
    })
}

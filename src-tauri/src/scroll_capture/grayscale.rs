//! 用于帧位移搜索的低成本灰度采样。

use image::RgbaImage;

/// 横向按目标宽度分块，块内抽样求加权亮度均值，得到灰度行网格；
/// 返回 (灰度数据, 输出宽度, 输出高度)，纵向不缩放。
pub(super) fn downsample(image: &RgbaImage, target_width: u32) -> (Vec<u8>, u32, u32) {
    let (width, height) = image.dimensions();
    let step_x = (width / target_width.max(1)).max(1);
    let output_width = (width / step_x).max(1);
    let raw = image.as_raw();
    let taps = step_x.clamp(1, 4);
    let tap_step = (step_x / taps).max(1);
    let mut output = Vec::with_capacity((output_width * height) as usize);
    for y in 0..height {
        let row_start = y as usize * width as usize * 4;
        for output_x in 0..output_width {
            let x_start = output_x * step_x;
            let mut sum = 0u32;
            for tap in 0..taps {
                let x = (x_start + tap * tap_step).min(width - 1);
                let index = row_start + x as usize * 4;
                sum += (299 * raw[index] as u32
                    + 587 * raw[index + 1] as u32
                    + 114 * raw[index + 2] as u32)
                    / 1000;
            }
            output.push((sum / taps) as u8);
        }
    }
    (output, output_width, height)
}

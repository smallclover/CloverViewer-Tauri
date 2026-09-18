//! 平台无关的帧比较指标。

use image::RgbaImage;

/// Sampled ratio of pixels whose RGB channel difference exceeds `tolerance`.
pub(super) fn diff_ratio(a: &RgbaImage, b: &RgbaImage, tolerance: i16) -> f32 {
    if a.dimensions() != b.dimensions() {
        return 1.0;
    }
    let (width, height) = a.dimensions();
    let (left, right) = (a.as_raw(), b.as_raw());
    let mut different = 0u32;
    let mut total = 0u32;
    let mut y = 0;
    while y < height {
        let mut x = 0;
        while x < width {
            let index = ((y * width + x) * 4) as usize;
            let difference = (left[index] as i16 - right[index] as i16).abs()
                | (left[index + 1] as i16 - right[index + 1] as i16).abs()
                | (left[index + 2] as i16 - right[index + 2] as i16).abs();
            if difference > tolerance {
                different += 1;
            }
            total += 1;
            x += 2;
        }
        y += 2;
    }
    if total == 0 {
        0.0
    } else {
        different as f32 / total as f32
    }
}

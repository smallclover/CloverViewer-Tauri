use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, RgbaImage};

const INSPECTION_WIDTH: u32 = 320;
const INSPECTION_MAX_HEIGHT: u32 = 260;

/// A sharp, bounded preview of one screen frame for the live stitch inspector.
/// Unlike the overview thumbnail, this deliberately preserves local detail so
/// the user can judge whether the blue trusted image and the next candidate
/// belong together.
pub(super) fn frame_data_url(frame: &RgbaImage) -> Option<String> {
    let width = INSPECTION_WIDTH.min(frame.width()).max(1);
    let proportional_height = ((frame.height() as u64 * width as u64)
        .saturating_add(frame.width().max(1) as u64 - 1)
        / frame.width().max(1) as u64) as u32;
    let height = proportional_height.min(INSPECTION_MAX_HEIGHT).max(1);
    let preview =
        image::imageops::resize(frame, width, height, image::imageops::FilterType::Lanczos3);
    let png = encode_png(&preview, true).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png)
    ))
}

// P1：实时预览（缩略图）
// ============================================================

/// 增量缩略图：每追加一段就往预览里贴一段，避免每帧重算整张长图（那是 O(H²)）。
pub(super) struct PreviewBuilder {
    width: u32,
    scale: f32,
    img: RgbaImage,
}

impl PreviewBuilder {
    pub(super) fn new(canvas_w: u32, width: u32) -> Self {
        let scale = width as f32 / canvas_w.max(1) as f32;
        Self {
            width,
            scale,
            img: RgbaImage::new(width, 0),
        }
    }

    /// 把「画布行区间 `canvas_y0..`」对应的一小段像素贴进预览
    pub(super) fn append_strip(&mut self, strip: &RgbaImage, canvas_y0: u32) {
        if strip.height() == 0 {
            return;
        }
        let py0 = (canvas_y0 as f32 * self.scale).round() as u32;
        let py1 = ((canvas_y0 + strip.height()) as f32 * self.scale)
            .round()
            .max(py0 as f32 + 1.0) as u32;
        let ph = py1 - py0;
        let scaled =
            image::imageops::resize(strip, self.width, ph, image::imageops::FilterType::Triangle);
        if self.img.height() < py1 {
            let mut bigger = RgbaImage::new(self.width, py1);
            image::imageops::overlay(&mut bigger, &self.img, 0, 0);
            self.img = bigger;
        }
        image::imageops::overlay(&mut self.img, &scaled, 0, py0 as i64);
    }

    /// 导出给前端的 data URL（超过 `max_h` 就整体压扁，保证 IPC 负载恒定）
    pub(super) fn data_url(&self, max_h: u32) -> Option<String> {
        if self.img.height() == 0 {
            return None;
        }
        let out = if self.img.height() > max_h {
            image::imageops::resize(
                &self.img,
                self.width,
                max_h,
                image::imageops::FilterType::Triangle,
            )
        } else {
            self.img.clone()
        };
        let png = encode_png(&out, false).ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png)
        ))
    }
}

/// PNG 编码。`small = true` 用 Fast/NoFilter（预览，追求速度）；否则用 Default/Adaptive
/// （最终长图，追求体积——20000px 高的长图用 NoFilter 能到几十 MB）。
pub(super) fn encode_png(img: &RgbaImage, small: bool) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let (ct, ft) = if small {
        (CompressionType::Fast, FilterType::NoFilter)
    } else {
        (CompressionType::Default, FilterType::Adaptive)
    };
    PngEncoder::new_with_quality(&mut out, ct, ft)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(out)
}

// ============================================================

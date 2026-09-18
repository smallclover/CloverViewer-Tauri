//! 与平台无关的长截图画布拼接。

use image::RgbaImage;

/// 单行指纹（整行采样 + 量化哈希），用于追加内容的重复度诊断。
fn row_hash(raw: &[u8], row_index: usize, width: u32, step: u32) -> u64 {
    let base = row_index * width as usize * 4;
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut x = 0u32;
    while x < width {
        let index = base + x as usize * 4;
        let packed = ((raw[index] >> 3) as u64) << 10
            | ((raw[index + 1] >> 3) as u64) << 5
            | (raw[index + 2] >> 3) as u64;
        hash = (hash ^ packed).wrapping_mul(0x0000_0100_0000_01b3);
        x += step;
    }
    hash
}

/// Return how much of the incoming new-content band occurs in the existing tail.
/// This is diagnostic only: repeated-looking rows are common in real documents.
pub(super) fn duplicate_ratio(
    canvas: &[u8],
    canvas_width: u32,
    canvas_height: u32,
    current: &RgbaImage,
    append_y: u32,
    band_end: u32,
) -> f32 {
    let band_end = band_end.min(current.height());
    let band_rows = band_end.saturating_sub(append_y);
    if band_rows == 0 || canvas_height == 0 || canvas_width != current.width() {
        return 0.0;
    }

    let tail_rows = canvas_height.min(current.height());
    let tail_start = canvas_height - tail_rows;
    let step = 4u32;
    let mut seen = std::collections::HashSet::with_capacity(tail_rows as usize);
    for y in tail_start..canvas_height {
        seen.insert(row_hash(canvas, y as usize, canvas_width, step));
    }

    let raw = current.as_raw();
    let mut hits = 0u32;
    for y in append_y..band_end {
        if seen.contains(&row_hash(raw, y as usize, canvas_width, step)) {
            hits += 1;
        }
    }
    hits as f32 / band_rows as f32
}

/// Append current-frame body pixels to the accumulated canvas.
/// The canvas stores the sticky header and scrolling body, but not a fixed footer.
pub(super) fn append_band(
    canvas: &mut Vec<u8>,
    canvas_width: u32,
    canvas_height: &mut u32,
    current: &RgbaImage,
    header_height: u32,
    footer_height: u32,
    shift: u32,
) -> Result<(), String> {
    let height = current.height();
    if canvas_width == 0 || height == 0 {
        return Err("append_band: 空帧".to_string());
    }
    if current.width() != canvas_width {
        return Err(format!(
            "append_band: 帧宽 {} 与画布宽 {canvas_width} 不一致",
            current.width()
        ));
    }

    let row_bytes = canvas_width as usize * 4;
    let header_height = header_height.min(height / 2);
    let footer_height = footer_height.min(height.saturating_sub(header_height).saturating_sub(1));
    let body_bottom = height - footer_height;
    if body_bottom <= header_height {
        return Err("append_band: 帧高不足以容纳页头/页脚".to_string());
    }

    let raw = current.as_raw();
    if shift == 0 {
        canvas.extend_from_slice(&raw[..body_bottom as usize * row_bytes]);
        *canvas_height += body_bottom;
        return Ok(());
    }

    let shift = shift.min(*canvas_height);
    let body_height = height - header_height - footer_height;
    let new_start = body_height.saturating_sub(shift) + header_height;
    canvas
        .extend_from_slice(&raw[new_start as usize * row_bytes..body_bottom as usize * row_bytes]);
    *canvas_height += body_bottom - new_start;
    debug_assert_eq!(canvas.len(), *canvas_height as usize * row_bytes);
    Ok(())
}

/// Append a fixed footer exactly once when the session finishes.
pub(super) fn attach_footer(
    canvas: &mut Vec<u8>,
    canvas_width: u32,
    canvas_height: &mut u32,
    last: &RgbaImage,
    footer_height: u32,
) {
    let height = last.height();
    let footer_height = footer_height.min(height.saturating_sub(1));
    if footer_height == 0 || last.width() != canvas_width {
        return;
    }
    let row_bytes = canvas_width as usize * 4;
    canvas.extend_from_slice(&last.as_raw()[(height - footer_height) as usize * row_bytes..]);
    *canvas_height += footer_height;
}

/// Remove the footer accidentally retained from the first frame before its height was known.
pub(super) fn trim_initial_footer(
    canvas: &mut Vec<u8>,
    canvas_width: u32,
    canvas_height: &mut u32,
    footer_height: u32,
) -> bool {
    if canvas_width == 0 || footer_height == 0 || footer_height > *canvas_height {
        return false;
    }
    let bytes = footer_height as usize * canvas_width as usize * 4;
    if bytes > canvas.len() {
        return false;
    }
    canvas.truncate(canvas.len() - bytes);
    *canvas_height -= footer_height;
    true
}

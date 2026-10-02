//! 测量截图采集与编码的耗时，不写盘也不显示截图。
//! Run: cargo run --release --manifest-path src-tauri/Cargo.toml --example screenshot_latency_probe
use base64::Engine;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use std::{hint::black_box, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    cloverviewer_tauri_lib::scroll_capture::ensure_dpi_aware();
    for round in 1..=3 {
        let started = Instant::now();
        let capture = cloverviewer_tauri_lib::screenshot_capture::capture_all(round)?;
        let capture_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut encode_ms = 0.0;
        let mut transfer_ms = 0.0;
        let mut raw_copy_ms = 0.0;
        let mut raw_bytes = 0;
        let pixels = u64::from(
            capture
                .data
                .screens
                .iter()
                .map(|screen| screen.width * screen.height)
                .sum::<u32>(),
        );
        let mut json_bytes = 0;
        for (index, screen) in capture.data.screens.iter().enumerate() {
            let frame = capture.frame(round, index)?;
            let stage = Instant::now();
            let mut png = Vec::new();
            PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::NoFilter)
                .write_image(
                    frame.as_slice(),
                    screen.width,
                    screen.height,
                    ExtendedColorType::Rgba8,
                )?;
            encode_ms += stage.elapsed().as_secs_f64() * 1000.0;
            let stage = Instant::now();
            let url = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&png)
            );
            // 统计 store 克隆与 JSON 响应这两项开销（不含 WebView 传输）。
            json_bytes += serde_json::to_vec(&url.clone())?.len();
            transfer_ms += stage.elapsed().as_secs_f64() * 1000.0;
            let stage = Instant::now();
            raw_bytes += black_box(frame.as_ref().clone()).len();
            raw_copy_ms += stage.elapsed().as_secs_f64() * 1000.0;
        }
        let stage = Instant::now();
        let metadata_bytes = serde_json::to_vec(&capture.data.clone())?.len();
        let raw_prepare_ms = raw_copy_ms + stage.elapsed().as_secs_f64() * 1000.0;
        println!("round={round} monitors={} pixels={pixels} capture_ms={capture_ms:.1} old_png_base64_json_ms={:.1} new_raw_copy_metadata_ms={raw_prepare_ms:.1} old_capture_prepare_ms={:.1} new_capture_prepare_ms={:.1} old_json_bytes={json_bytes} new_raw_bytes={raw_bytes} new_metadata_bytes={metadata_bytes}", capture.data.screens.len(), encode_ms + transfer_ms, capture_ms + encode_ms + transfer_ms, capture_ms + raw_prepare_ms);
    }
    Ok(())
}

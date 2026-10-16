use base64::Engine;
use image::{DynamicImage, ImageDecoder};
use std::{fs, path::Path};

pub fn read_oriented(path: &str) -> Result<DynamicImage, String> {
    let mut decoder = image::ImageReader::open(path)
        .map_err(|error| error.to_string())?
        .into_decoder()
        .map_err(|error| error.to_string())?;
    let orientation = decoder.orientation().map_err(|error| error.to_string())?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|error| error.to_string())?;
    image.apply_orientation(orientation);
    Ok(image)
}

pub fn decode_canvas_png(png: &str) -> Result<DynamicImage, String> {
    let source = png.split_once(',').map_or(png, |(_, source)| source);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(source)
        .map_err(|error| error.to_string())?;
    image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|error| error.to_string())
}

pub fn read_pixels(path: &str, png: Option<&str>) -> Result<DynamicImage, String> {
    match png {
        Some(png) => decode_canvas_png(png),
        None => read_oriented(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_png_pixels_do_not_require_a_native_avif_decoder() {
        let image = image::RgbImage::from_pixel(2, 3, image::Rgb([12, 34, 56]));
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        let decoded = read_pixels("not-native.avif", Some(&encoded)).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2, 3));
        assert_eq!(decoded.to_rgb8().get_pixel(0, 0).0, [12, 34, 56]);
        assert!(decode_canvas_png("invalid").is_err());
    }

    #[test]
    fn native_copy_and_share_pixels_apply_jpeg_exif_orientation() {
        let source = image::RgbImage::from_fn(2, 3, |x, y| {
            image::Rgb([(x * 70) as u8, (y * 60) as u8, 20])
        });
        let mut encoded = std::io::Cursor::new(Vec::new());
        source
            .write_to(&mut encoded, image::ImageFormat::Jpeg)
            .unwrap();
        let jpeg = encoded.into_inner();
        let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0".to_vec();
        exif.extend_from_slice(&1u16.to_le_bytes());
        exif.extend_from_slice(&0x0112u16.to_le_bytes());
        exif.extend_from_slice(&3u16.to_le_bytes());
        exif.extend_from_slice(&1u32.to_le_bytes());
        exif.extend_from_slice(&6u16.to_le_bytes());
        exif.extend_from_slice(&[0; 6]);
        let mut oriented = jpeg[..2].to_vec();
        oriented.extend_from_slice(&[0xff, 0xe1]);
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend_from_slice(&exif);
        oriented.extend_from_slice(&jpeg[2..]);
        let path =
            std::env::temp_dir().join(format!("clover-orientation-{}.jpg", std::process::id()));
        std::fs::write(&path, &oriented).unwrap();
        let decoded = read_oriented(path.to_str().unwrap()).unwrap().to_rgb8();
        let raw = image::load_from_memory(&oriented).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (3, 2));
        assert_eq!(decoded.get_pixel(0, 0), raw.get_pixel(0, 2));
        std::fs::remove_file(path).unwrap();
    }
}

pub fn read_data_url(path: String) -> Result<String, String> {
    let img = crate::image_io::read_oriented(&path)?;

    let mut png_bytes = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut png_bytes),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("编码失败: {e}"))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

pub fn read_editable_data_url(path: String) -> Result<String, String> {
    let extension = Path::new(&path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "bmp" => Some("image/bmp"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        _ => None,
    };
    if let Some(mime) = mime {
        let bytes = fs::read(&path).map_err(|e| format!("读取图片失败：{e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(format!("data:{mime};base64,{b64}"));
    }
    // TIFF 等浏览器不直接支持的格式沿用原有 Rust 解码 → PNG 路径。
    read_data_url(path)
}

pub fn save_edited(path: String, png: String, format: String) -> Result<(), String> {
    let source = png.split_once(',').map_or(png.as_str(), |(_, value)| value);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(source)
        .map_err(|e| format!("编辑结果不是有效 Base64：{e}"))?;
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| format!("无法解码编辑结果：{e}"))?;
    let encoded = encode_edited(&image, &format)?;
    crate::atomic_file::write(Path::new(&path), &encoded)
        .map_err(|e| format!("无法写入图片：{e}"))?;
    tracing::info!("已保存编辑图片: {path}");
    Ok(())
}

fn encode_edited(image: &DynamicImage, format: &str) -> Result<Vec<u8>, String> {
    let target_format = match format {
        "png" => image::ImageFormat::Png,
        "jpeg" => image::ImageFormat::Jpeg,
        "webp" => image::ImageFormat::WebP,
        _ => return Err(format!("不支持的导出格式: {format}")),
    };

    // 先完整编码到内存；编码失败时绝不截断用户的原文件。
    let mut encoded = Vec::new();
    if target_format == image::ImageFormat::Jpeg {
        let rgba = image.to_rgba8();
        let rgb = image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
            let pixel = rgba.get_pixel(x, y);
            let alpha = u32::from(pixel[3]);
            image::Rgb([0, 1, 2].map(|channel| {
                ((u32::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
            }))
        });
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 90)
            .encode_image(&rgb)
            .map_err(|error| error.to_string())?;
    } else {
        image
            .write_to(&mut std::io::Cursor::new(&mut encoded), target_format)
            .map_err(|error| error.to_string())?;
    }
    Ok(encoded)
}

#[cfg(test)]
mod export_tests {
    use super::*;
    #[test]
    fn jpeg_flattens_transparency_on_white_and_png_preserves_alpha() {
        for (pixel, expected) in [
            ([0, 0, 0, 0], [255, 255, 255]),
            ([255, 0, 0, 128], [255, 127, 127]),
        ] {
            let image =
                DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(1, 1, image::Rgba(pixel)));
            let jpeg = image::load_from_memory(&encode_edited(&image, "jpeg").unwrap())
                .unwrap()
                .to_rgb8();
            for (actual, expected) in jpeg.get_pixel(0, 0).0.into_iter().zip(expected) {
                assert!(u8::abs_diff(actual, expected) <= 8);
            }
            let png = image::load_from_memory(&encode_edited(&image, "png").unwrap())
                .unwrap()
                .to_rgba8();
            assert_eq!(png.get_pixel(0, 0).0, pixel);
            assert!(encode_edited(&image, "unsupported").is_err());
        }
    }
}

//! EXIF 详细信息读取，供属性面板展示。
//!
//! 读取拍摄时间（ImageProperties.date）之外，还扩展出相机/ISO/光圈/快门/焦距等
//! 常见字段，供属性面板展示。字段为空时前端不展示该行。

use serde::Serialize;
use std::io::{BufRead, BufReader, Seek};

#[derive(Debug, Clone, Serialize, Default)]
pub struct ExifInfo {
    /// 拍摄时间（已规范化 YYYY-MM-DD HH:MM:SS）
    pub datetime: String,
    pub make: String,
    pub model: String,
    pub iso: String,
    pub f_number: String,
    pub exposure_time: String,
    pub focal_length: String,
    pub lens_model: String,
}

#[tauri::command]
pub async fn get_image_info(path: String) -> Result<ExifInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&path).map_err(|e| format!("读取失败: {e}"))?;
        // 交给 EXIF 解析器按容器读取即可：JPEG 的元数据不需要像素数据。
        Ok(read_exif(&mut BufReader::new(file)))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn read_exif(reader: &mut (impl BufRead + Seek)) -> ExifInfo {
    let mut info = ExifInfo::default();
    let Ok(exif) = exif::Reader::new().read_from_container(reader) else {
        return info;
    };

    let get = |tag: exif::Tag| {
        exif.get_field(tag, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string())
            .unwrap_or_default()
    };

    info.datetime = get(exif::Tag::DateTime);
    // 规范化日期格式 YYYY:MM:DD -> YYYY-MM-DD
    if let Some((d, t)) = info.datetime.split_once(' ') {
        info.datetime = format!("{} {}", d.replace(':', "-"), t);
    }

    info.make = get(exif::Tag::Make);
    info.model = get(exif::Tag::Model);
    info.f_number = get(exif::Tag::FNumber);
    info.exposure_time = get(exif::Tag::ExposureTime);
    info.focal_length = get(exif::Tag::FocalLength);
    info.lens_model = get(exif::Tag::LensModel);

    // ISO：优先 PhotographicSensitivity，回退 ISOSpeed
    let iso = get(exif::Tag::PhotographicSensitivity);
    info.iso = if iso.is_empty() {
        get(exif::Tag::ISOSpeed)
    } else {
        iso
    };

    info
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn jpeg_metadata_preserves_dates_without_reading_the_large_pixel_payload() {
        let mut tiff = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x0132u16.to_le_bytes()); // DateTime（拍摄时间）
        tiff.extend_from_slice(&2u16.to_le_bytes()); // ASCII 编码
        tiff.extend_from_slice(&20u32.to_le_bytes());
        tiff.extend_from_slice(&26u32.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff.extend_from_slice(b"2026:10:01 11:00:00\0");
        let mut jpeg = b"\xff\xd8\xff\xe1".to_vec();
        jpeg.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(&tiff);
        jpeg.extend_from_slice(b"\xff\xd9");
        jpeg.resize(2 * 1024 * 1024, 0);
        let mut reader = Cursor::new(jpeg);

        let info = read_exif(&mut reader);

        assert_eq!(info.datetime, "2026-10-01 11:00:00");
        assert!(reader.position() <= 8192);
        assert!(info.model.is_empty());
    }
}

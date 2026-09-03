//! EXIF 详细信息读取 —— 移植自 CloverViewer core/image_loader.rs 的 EXIF 逻辑并扩展。
//!
//! 原版只读取拍摄时间（ImageProperties.date），此处扩展出相机/ISO/光圈/快门/焦距等
//! 常见字段，供属性面板展示。字段为空时前端不展示该行。

use serde::Serialize;
use std::io::Cursor;

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
pub fn get_image_info(path: String) -> Result<ExifInfo, String> {
    let data = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
    Ok(read_exif(&data))
}

fn read_exif(data: &[u8]) -> ExifInfo {
    let mut info = ExifInfo::default();
    let Ok(exif) = exif::Reader::new().read_from_container(&mut Cursor::new(data)) else {
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

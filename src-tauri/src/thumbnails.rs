//! 缩略图生成 + 内存 LRU 缓存 —— 移植自 CloverViewer core/image_loader.rs 的缩略图逻辑
//!
//! 与 egui 版的关键差异：egui 版把缩略图作为 GPU 纹理缓存；Tauri 版 WebView2 直接
//! 消费 base64 PNG data URL，因此这里改为「解码 → EXIF 旋转 → cover 裁剪 → PNG → base64」。
//! 内存 LRU 缓存避免同一目录重复浏览时的反复解码。

use base64::Engine;
use lru::LruCache;
use std::io::Cursor;
use std::num::NonZeroUsize;
use std::sync::Mutex;
use tauri::State;

/// 缩略图内存缓存（key: `path#size` -> PNG data URL）
pub struct ThumbnailStore {
    cache: Mutex<LruCache<String, String>>,
}

impl ThumbnailStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            cache: Mutex::new(LruCache::new(NonZeroUsize::new(capacity.max(1)).unwrap())),
        }
    }
}

/// 生成缩略图（等比 cover 裁剪到 size×size），返回 PNG data URL
#[tauri::command]
pub fn get_thumbnail(
    store: State<'_, ThumbnailStore>,
    path: String,
    size: u32,
) -> Result<String, String> {
    let size = size.clamp(32, 1024);
    let key = format!("{path}#{size}");

    if let Some(hit) = store.cache.lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }

    let data_url = generate_thumbnail(&path, size)?;

    store.cache.lock().unwrap().put(key, data_url.clone());
    Ok(data_url)
}

fn generate_thumbnail(path: &str, size: u32) -> Result<String, String> {
    let data = std::fs::read(path).map_err(|e| format!("读取失败: {e}"))?;

    let orientation = read_orientation(&data);
    let img = image::load_from_memory(&data).map_err(|e| format!("解码失败: {e}"))?;
    let mut img = img;
    img.apply_orientation(map_orientation(orientation));

    // 等比缩放（不裁剪、不放大），保留原始宽高比，前端 object-fit:contain 显示
    let img = img.thumbnail(size, size);

    let mut png = Vec::new();
    img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("编码失败: {e}"))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// 从 EXIF 读 Orientation（无 EXIF 时返回 1 = 无变换）
fn read_orientation(data: &[u8]) -> u8 {
    if let Ok(exif) = exif::Reader::new().read_from_container(&mut Cursor::new(data)) {
        return exif
            .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
            .unwrap_or(1) as u8;
    }
    1
}

fn map_orientation(orientation: u8) -> image::metadata::Orientation {
    use image::metadata::Orientation;
    match orientation {
        2 => Orientation::FlipHorizontal,
        3 => Orientation::Rotate180,
        4 => Orientation::FlipVertical,
        5 => Orientation::Rotate90FlipH,
        6 => Orientation::Rotate90,
        7 => Orientation::Rotate270FlipH,
        8 => Orientation::Rotate270,
        _ => Orientation::NoTransforms,
    }
}

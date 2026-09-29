//! 缩略图生成 + 内存 LRU 缓存 —— 移植自 CloverViewer core/image_loader.rs 的缩略图逻辑
//!
//! 与 egui 版的关键差异：egui 版把缩略图作为 GPU 纹理缓存；Tauri 版 WebView2 直接
//! 消费 base64 data URL，因此这里改为「解码 → EXIF 旋转 → 缩放 → JPEG/PNG → base64」。
//! 内存 LRU 和有上限的磁盘缓存避免同一目录重复浏览时的反复解码。

use base64::Engine;
use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::Cursor,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::State;

const DISK_CACHE_LIMIT: usize = 512;
const DISK_CACHE_MAX_BYTES: u64 = 128 * 1024 * 1024;

/// 缩略图内存缓存（key: `path#size` -> JPEG 或 PNG data URL）
pub struct ThumbnailStore {
    cache: Mutex<LruCache<String, String>>,
    disk_cache_dir: Mutex<Option<PathBuf>>,
}

impl ThumbnailStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            cache: Mutex::new(LruCache::new(NonZeroUsize::new(capacity.max(1)).unwrap())),
            disk_cache_dir: Mutex::new(None),
        }
    }

    /// 磁盘缓存放在 Tauri 的应用缓存目录，而不是用户图片目录或系统临时目录。
    /// 目录不可用时仅退化为内存缓存，浏览图片不应因此失败。
    pub fn configure_disk_cache(&self, dir: PathBuf) {
        if let Err(error) = fs::create_dir_all(&dir) {
            tracing::warn!("无法创建缩略图磁盘缓存 {}: {error}", dir.display());
            return;
        }
        *self.disk_cache_dir.lock().unwrap() = Some(dir.clone());
        trim_disk_cache(&dir);
    }

    fn read_disk_cache(&self, path: &str, size: u32) -> Option<String> {
        let file = self.disk_cache_file(path, size)?;
        let data_url = fs::read_to_string(file).ok()?;
        data_url.starts_with("data:image/").then_some(data_url)
    }

    fn write_disk_cache(&self, path: &str, size: u32, data_url: &str) {
        let Some(file) = self.disk_cache_file(path, size) else {
            return;
        };
        if let Err(error) = fs::write(&file, data_url) {
            tracing::debug!("无法写入缩略图磁盘缓存 {}: {error}", file.display());
            return;
        }
        if let Some(dir) = file.parent() {
            trim_disk_cache(dir);
        }
    }

    fn disk_cache_file(&self, path: &str, size: u32) -> Option<PathBuf> {
        let dir = self.disk_cache_dir.lock().unwrap().clone()?;
        let metadata = fs::metadata(path).ok()?;
        let modified = metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos();
        let mut hasher = DefaultHasher::new();
        path.hash(&mut hasher);
        size.hash(&mut hasher);
        metadata.len().hash(&mut hasher);
        modified.hash(&mut hasher);
        Some(dir.join(format!("{:016x}.data-url", hasher.finish())))
    }
}

/// 生成缩略图（等比缩放到 size 范围内），返回 JPEG 或 PNG data URL
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

    if let Some(hit) = store.read_disk_cache(&path, size) {
        store.cache.lock().unwrap().put(key, hit.clone());
        return Ok(hit);
    }

    let data_url = generate_thumbnail(&path, size)?;

    store.cache.lock().unwrap().put(key, data_url.clone());
    store.write_disk_cache(&path, size, &data_url);
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

    encode_thumbnail(&img, Path::new(path))
}

/// 照片走 JPEG；带透明通道或无损源格式走 PNG，避免图标和截图变大、变糊。
fn encode_thumbnail(img: &image::DynamicImage, source: &Path) -> Result<String, String> {
    let (mime, encoded) = if should_use_png(img, source) {
        let mut png = Vec::new();
        img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| format!("PNG 编码失败: {e}"))?;
        ("image/png", png)
    } else {
        let mut jpeg = Vec::new();
        let rgb = img.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85)
            .encode_image(&rgb)
            .map_err(|e| format!("JPEG 编码失败: {e}"))?;
        ("image/jpeg", jpeg)
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(encoded);
    Ok(format!("data:{mime};base64,{b64}"))
}

fn should_use_png(img: &image::DynamicImage, source: &Path) -> bool {
    if img.has_alpha() {
        return true;
    }
    matches!(
        source
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "gif" | "bmp" | "ico")
    )
}

/// 仅管理本模块在应用专属目录中写入的普通缓存文件，不跟随链接。
fn trim_disk_cache(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file() || entry.path().extension()? != "data-url" {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().ok()?;
            Some((entry.path(), modified, metadata.len()))
        })
        .collect::<Vec<_>>();
    files.sort_unstable_by_key(|(_, modified, _)| *modified);

    let mut remaining_files = files.len();
    let mut remaining_bytes = files.iter().map(|(_, _, bytes)| bytes).sum::<u64>();
    for (path, _, bytes) in files {
        if remaining_files <= DISK_CACHE_LIMIT && remaining_bytes <= DISK_CACHE_MAX_BYTES {
            break;
        }
        if let Err(error) = fs::remove_file(&path) {
            tracing::debug!("无法淘汰缩略图缓存 {}: {error}", path.display());
        } else {
            remaining_files -= 1;
            remaining_bytes = remaining_bytes.saturating_sub(bytes);
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage, Rgba, RgbaImage};

    #[test]
    fn opaque_thumbnails_use_jpeg() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(2, 2, Rgb([20, 40, 60])));
        assert!(encode_thumbnail(&image, Path::new("photo.jpg"))
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn transparent_thumbnails_keep_png() {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, Rgba([20, 40, 60, 100])));
        assert!(encode_thumbnail(&image, Path::new("icon.png"))
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn opaque_lossless_source_keeps_png() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(2, 2, Rgb([20, 40, 60])));
        assert!(encode_thumbnail(&image, Path::new("capture.PNG"))
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }
}

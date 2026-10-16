//! 缩略图生成 + 内存 LRU 缓存 —— 移植自 CloverViewer core/image_loader.rs 的缩略图逻辑
//!
//! 与 egui 版的关键差异：egui 版把缩略图作为 GPU 纹理缓存；Tauri 版 WebView2 直接
//! 消费 base64 data URL，因此这里改为「解码 → EXIF 旋转 → 缩放 → JPEG/PNG → base64」。
//! 内存 LRU 和有上限的磁盘缓存避免同一目录重复浏览时的反复解码。

use base64::Engine;
use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::Cursor,
    path::{Path, PathBuf},
};
use tauri::Manager;

const DISK_CACHE_LIMIT: usize = 512;
const DISK_CACHE_MAX_BYTES: u64 = 128 * 1024 * 1024;
const MEMORY_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;

fn cache_thumbnail(
    cache: &mut LruCache<String, String>,
    key: String,
    value: String,
    budget: usize,
) {
    if value.len() > budget {
        return;
    }
    cache.put(key, value);
    let mut bytes = cache.iter().map(|(_, value)| value.len()).sum::<usize>();
    while bytes > budget {
        if let Some((_, value)) = cache.pop_lru() {
            bytes -= value.len();
        } else {
            break;
        }
    }
}

/// 内存和磁盘缓存共用包含原图版本的 key。
pub struct ThumbnailStore {
    cache: Mutex<LruCache<String, String>>,
    disk_cache_dir: Mutex<Option<PathBuf>>,
    writes_since_trim: AtomicUsize,
}

impl ThumbnailStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            cache: Mutex::new(LruCache::new(NonZeroUsize::new(capacity.max(1)).unwrap())),
            disk_cache_dir: Mutex::new(None),
            writes_since_trim: AtomicUsize::new(0),
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

    fn read_disk_cache(&self, key: &str) -> Option<String> {
        let file = self.disk_cache_file(key)?;
        let data_url = fs::read_to_string(file).ok()?;
        data_url.starts_with("data:image/").then_some(data_url)
    }

    fn write_disk_cache(&self, key: &str, data_url: &str) {
        let Some(file) = self.disk_cache_file(key) else {
            return;
        };
        if let Err(error) = fs::write(&file, data_url) {
            tracing::debug!("无法写入缩略图磁盘缓存 {}: {error}", file.display());
            return;
        }
        if let Some(dir) = file
            .parent()
            .filter(|_| self.writes_since_trim.fetch_add(1, Ordering::Relaxed) % 16 == 15)
        {
            trim_disk_cache(dir);
        }
    }

    fn disk_cache_file(&self, key: &str) -> Option<PathBuf> {
        let dir = self.disk_cache_dir.lock().unwrap().clone()?;
        let mut hasher = DefaultHasher::new();
        key.hash(&mut hasher);
        Some(dir.join(format!("{:016x}.data-url", hasher.finish())))
    }

    fn get(&self, path: &str, size: u32) -> Result<String, String> {
        let size = size.clamp(32, 1024);
        let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
        let modified = metadata.modified().map_err(|error| error.to_string())?;
        let key = format!("{path}#{size}#{}#{modified:?}", metadata.len());
        if let Some(hit) = self.cache.lock().unwrap().get(&key) {
            return Ok(hit.clone());
        }
        if let Some(hit) = self.read_disk_cache(&key) {
            cache_thumbnail(
                &mut self.cache.lock().unwrap(),
                key,
                hit.clone(),
                MEMORY_CACHE_MAX_BYTES,
            );
            return Ok(hit);
        }
        let data_url = generate_thumbnail(path, size)?;
        cache_thumbnail(
            &mut self.cache.lock().unwrap(),
            key.clone(),
            data_url.clone(),
            MEMORY_CACHE_MAX_BYTES,
        );
        self.write_disk_cache(&key, &data_url);
        Ok(data_url)
    }
}

/// 生成缩略图（等比缩放到 size 范围内），返回 JPEG 或 PNG data URL
#[tauri::command]
pub async fn get_thumbnail(
    app: tauri::AppHandle,
    path: String,
    size: u32,
) -> Result<String, String> {
    crate::image_tasks::run(move || app.state::<ThumbnailStore>().get(&path, size)).await
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
    fn memory_cache_evicts_by_bytes_and_does_not_keep_oversized_thumbnails() {
        let mut cache = LruCache::new(NonZeroUsize::new(10).unwrap());
        cache_thumbnail(&mut cache, "a".into(), "12345".into(), 8);
        cache_thumbnail(&mut cache, "b".into(), "67890".into(), 8);
        assert!(cache.get("a").is_none());
        assert!(cache.get("b").is_some());
        cache_thumbnail(&mut cache, "large".into(), "123456789".into(), 8);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn overwriting_a_source_invalidates_memory_and_disk_thumbnails() {
        let directory =
            std::env::temp_dir().join(format!("clover-thumbnail-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("source.png");
        let store = ThumbnailStore::new(4);
        store.configure_disk_cache(directory.join("cache"));
        RgbImage::from_pixel(2, 2, Rgb([255, 0, 0]))
            .save(&source)
            .unwrap();
        let first = store.get(source.to_str().unwrap(), 64).unwrap();
        RgbImage::from_pixel(3, 3, Rgb([0, 255, 0]))
            .save(&source)
            .unwrap();
        let replacement = store.get(source.to_str().unwrap(), 64).unwrap();
        assert_ne!(first, replacement);
        store.cache.lock().unwrap().clear();
        assert_eq!(
            replacement,
            store.get(source.to_str().unwrap(), 64).unwrap()
        );
        fs::remove_dir_all(directory).unwrap();
    }

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

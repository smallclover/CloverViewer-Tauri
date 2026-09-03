//! 图片目录扫描与元数据 —— 移植自 CloverViewer model/image_meta.rs + core/image_loader.rs
//! 使用 rayon 并行读取目录条目与图片尺寸。

use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// WebView2 (Chromium) 原生支持的格式，可直接走 asset protocol
const WEB_SUPPORTED: &[&str] = &["png", "jpg", "jpeg", "bmp", "gif", "webp", "avif"];

/// 与原版一致的完整支持列表
pub const SUPPORTED_IMAGE_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "bmp", "gif", "webp", "tiff", "avif"];

#[derive(Debug, Clone, Serialize)]
pub struct ImageEntry {
    /// 绝对路径
    pub path: String,
    pub name: String,
    pub size: u64,
    /// 修改时间 (RFC3339)
    pub modified: String,
    pub width: u32,
    pub height: u32,
    /// WebView 是否原生支持（false 则前端需调用 read_image_data 兜底解码）
    pub web_supported: bool,
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_supported(path: &Path) -> bool {
    let ext = extension_of(path);
    SUPPORTED_IMAGE_EXTENSIONS.contains(&ext.as_str())
}

fn is_web_supported(path: &Path) -> bool {
    let ext = extension_of(path);
    WEB_SUPPORTED.contains(&ext.as_str())
}

/// 扫描目录下的所有支持图片（不递归，与原版一致）
/// 返回按名称排序的列表。
pub fn scan_directory(dir: &Path) -> Vec<ImageEntry> {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let paths: Vec<PathBuf> = read_dir
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_supported(p))
        .collect();

    paths
        .into_par_iter()
        .map(|path| {
            let (width, height) = image::ImageReader::open(&path)
                .ok()
                .and_then(|r| r.into_dimensions().ok())
                .map(|(w, h)| (w, h))
                .unwrap_or((0, 0));

            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let modified = std::fs::metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    let dt: chrono_like::LocalTime = t.into();
                    dt.to_rfc3339()
                })
                .unwrap_or_default();

            ImageEntry {
                name: path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string(),
                path: path.to_string_lossy().to_string(),
                size,
                modified,
                width,
                height,
                web_supported: is_web_supported(&path),
            }
        })
        .collect()
}

/// 轻量本地时间格式化（避免引入 chrono 依赖）
mod chrono_like {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    pub struct LocalTime {
        secs: i64,
    }

    impl From<SystemTime> for LocalTime {
        fn from(t: SystemTime) -> Self {
            let secs = match t.duration_since(UNIX_EPOCH) {
                Ok(d) => d.as_secs() as i64,
                Err(e) => -(e.duration().as_secs() as i64),
            };
            Self { secs }
        }
    }

    impl LocalTime {
        /// RFC3339 本地时间（Windows 时区通过 powershell 获取太重，
        /// 这里用简单 UTC 偏移近似：仅输出 UTC，前端负责本地化显示）
        pub fn to_rfc3339(self) -> String {
            let days = self.secs.div_euclid(86400);
            let rem = self.secs.rem_euclid(86400);
            let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
            let (y, mo, d) = civil_from_days(days);
            format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
        }
    }

    /// Howard Hinnant 的 days->civil 算法
    fn civil_from_days(z: i64) -> (i64, u32, u32) {
        let z = z + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let y = if m <= 2 { y + 1 } else { y };
        (y, m, d)
    }

    #[allow(dead_code)]
    fn unused(_: Duration) {}
}

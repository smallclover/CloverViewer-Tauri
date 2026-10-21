//! Opt-in component lifecycle. Downloads are staged; only verified complete sets become usable.
use super::assets::{self, Asset};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        RwLock,
    },
    time::Duration,
};

pub static ACCESS: RwLock<()> = RwLock::new(());
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static RECEIVED: AtomicU64 = AtomicU64::new(0);
pub const SUPPORTED: bool = cfg!(all(windows, target_arch = "x86_64"));

#[derive(serde::Serialize)]
pub struct ModelStatus {
    supported: bool,
    installed: bool,
    busy: bool,
    downloaded_bytes: u64,
    download_bytes: u64,
    installed_bytes: u64,
}

pub fn directory() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|p| p.join("CloverViewer").join("ocr").join(assets::VERSION))
        .ok_or_else(|| "OCR_STORAGE_UNAVAILABLE".into())
}

fn files() -> Vec<(&'static str, u64)> {
    let mut files = vec![
        (assets::DET.name, assets::DET.bytes),
        (assets::REC.name, assets::REC.bytes),
    ];
    files.extend(
        assets::RUNTIME_FILES
            .iter()
            .map(|&(name, bytes, _)| (name, bytes)),
    );
    files
}

fn managed_names() -> Vec<String> {
    let mut names: Vec<String> = files().iter().map(|(n, _)| n.to_string()).collect();
    names.extend(
        [
            "ready",
            "runtime.zip",
            "PaddleOCR-LICENSE",
            "det.onnx.part",
            "rec.onnx.part",
            "runtime.zip.part",
        ]
        .map(String::from),
    );
    names
}

pub fn installed_at(dir: &Path) -> bool {
    fs::read_to_string(dir.join("ready")).is_ok_and(|s| s == assets::VERSION)
        && files().iter().all(|(name, bytes)| {
            fs::metadata(dir.join(name)).is_ok_and(|m| m.is_file() && m.len() == *bytes)
        })
}

#[tauri::command]
pub fn get_ocr_model_status() -> Result<ModelStatus, String> {
    let dir = directory()?;
    let installed_bytes = managed_names()
        .iter()
        .map(|name| fs::metadata(dir.join(name)).map(|m| m.len()).unwrap_or(0))
        .sum();
    Ok(ModelStatus {
        supported: SUPPORTED,
        installed: installed_at(&dir),
        busy: DOWNLOADING.load(Ordering::Acquire),
        downloaded_bytes: RECEIVED.load(Ordering::Relaxed),
        download_bytes: assets::DOWNLOAD_BYTES,
        installed_bytes,
    })
}

struct DownloadGuard;
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        DOWNLOADING.store(false, Ordering::Release);
    }
}
struct PartialFile(PathBuf);
impl Drop for PartialFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn cancelled() -> Result<(), String> {
    if CANCEL.load(Ordering::Relaxed) {
        Err("OCR_DOWNLOAD_CANCELLED".into())
    } else {
        Ok(())
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    // Share the existing updater's ring backend instead of adding another TLS provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .user_agent("CloverViewer-OCR")
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|e| e.to_string())
}

async fn download(client: &reqwest::Client, dir: &Path, asset: &Asset) -> Result<(), String> {
    cancelled()?;
    let target = dir.join(asset.name);
    // A retry reuses already verified completed files, never a partial transfer.
    if assets::check_file(&target, asset.bytes, asset.sha256).is_ok() {
        RECEIVED.fetch_add(asset.bytes, Ordering::Relaxed);
        return Ok(());
    }
    let partial = PartialFile(dir.join(format!("{}.part", asset.name)));
    let mut file = fs::File::create(&partial.0).map_err(|e| e.to_string())?;
    let mut response = client
        .get(asset.url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut size = 0;
    loop {
        cancelled()?;
        let chunk = tokio::select! {
            result = response.chunk() => result.map_err(|e| e.to_string())?,
            _ = tokio::time::sleep(Duration::from_millis(200)) => { cancelled()?; continue; }
        };
        let Some(chunk) = chunk else {
            break;
        };
        size += chunk.len() as u64;
        if size > asset.bytes {
            return Err("OCR_MODEL_CORRUPT".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        RECEIVED.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    assets::check_file(&partial.0, asset.bytes, asset.sha256)?;
    cancelled()?;
    fs::rename(&partial.0, target).map_err(|e| e.to_string())
}

fn install_runtime(dir: &Path) -> Result<(), String> {
    let _access = ACCESS.write().map_err(|e| e.to_string())?;
    cancelled()?;
    let archive = fs::File::open(dir.join(assets::RUNTIME.name)).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(archive).map_err(|e| e.to_string())?;
    for &(name, bytes, hash) in assets::RUNTIME_FILES {
        // Fixed names only: no paths supplied by the archive are used for extraction.
        let archive_name = if name.ends_with(".dll") {
            format!("onnxruntime-win-x64-1.22.0/lib/{name}")
        } else {
            format!("onnxruntime-win-x64-1.22.0/{name}")
        };
        let mut source = zip.by_name(&archive_name).map_err(|e| e.to_string())?;
        if source.size() != bytes {
            return Err("OCR_MODEL_CORRUPT".into());
        }
        let mut content = Vec::new();
        source
            .by_ref()
            .take(bytes + 1)
            .read_to_end(&mut content)
            .map_err(|e| e.to_string())?;
        crate::atomic_file::write(&dir.join(name), &content).map_err(|e| e.to_string())?;
        assets::check_file(&dir.join(name), bytes, hash)?;
    }
    assets::verify(dir)?;
    cancelled()?;
    crate::atomic_file::write(
        &dir.join("PaddleOCR-LICENSE"),
        include_bytes!("../../../docs/PaddleOCR-LICENSE"),
    )
    .map_err(|e| e.to_string())?;
    crate::atomic_file::write(&dir.join("ready"), assets::VERSION.as_bytes())
        .map_err(|e| e.to_string())?;
    drop(zip);
    let _ = fs::remove_file(dir.join(assets::RUNTIME.name));
    Ok(())
}

#[tauri::command]
pub async fn download_ocr_model() -> Result<ModelStatus, String> {
    if !SUPPORTED {
        return Err("OCR_UNSUPPORTED".into());
    }
    {
        let _access = ACCESS
            .try_write()
            .map_err(|_| "OCR_MODEL_BUSY".to_string())?;
        DOWNLOADING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "OCR_MODEL_BUSY".to_string())?;
    }
    let guard = DownloadGuard;
    CANCEL.store(false, Ordering::Relaxed);
    RECEIVED.store(0, Ordering::Relaxed);
    let dir = directory()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !installed_at(&dir) {
        let client = http_client()?;
        for asset in [&assets::DET, &assets::REC, &assets::RUNTIME] {
            download(&client, &dir, asset).await?;
        }
        tokio::task::spawn_blocking(move || install_runtime(&dir))
            .await
            .map_err(|e| e.to_string())??;
    }
    drop(guard);
    get_ocr_model_status()
}

#[tauri::command]
pub fn cancel_ocr_model_download() {
    CANCEL.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn remove_ocr_model(
    store: tauri::State<'_, crate::config::ConfigStore>,
) -> Result<ModelStatus, String> {
    let _access = ACCESS
        .try_write()
        .map_err(|_| "OCR_MODEL_BUSY".to_string())?;
    if DOWNLOADING.load(Ordering::Acquire) {
        return Err("OCR_MODEL_BUSY".into());
    }
    // Persist before removing anything: a failed write leaves a working installation intact.
    store.update_saved(|config| config.ocr_engine = crate::config::OcrEngine::System)?;
    remove_at(&directory()?)?;
    get_ocr_model_status()
}

fn remove_at(dir: &Path) -> Result<(), String> {
    let mut error = None;
    for name in managed_names() {
        if let Err(e) = fs::remove_file(dir.join(name)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                error = Some(e.to_string());
            }
        }
    }
    if let Some(error) = error {
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;

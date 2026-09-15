use image::{DynamicImage, ImageFormat};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
static NEXT_ARTIFACT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotArtifact {
    pub capture_id: String,
    pub path: String,
    pub source: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub created_at_unix_ms: u128,
    pub bytes: u64,
}

#[derive(Default)]
pub struct ArtifactStore {
    artifacts: Mutex<HashMap<String, ScreenshotArtifact>>,
}

impl ArtifactStore {
    pub fn save(
        &self,
        image: DynamicImage,
        source: String,
        x: i32,
        y: i32,
    ) -> Result<ScreenshotArtifact, String> {
        self.cleanup_expired()?;
        let created_at_unix_ms = now_ms();
        let sequence = NEXT_ARTIFACT.fetch_add(1, Ordering::Relaxed);
        let capture_id = format!(
            "cv-{created_at_unix_ms:x}-{:x}-{sequence:x}",
            std::process::id()
        );
        let directory = artifact_dir()?;
        fs::create_dir_all(&directory)
            .map_err(|e| format!("Failed to create screenshot directory: {e}"))?;
        let path = directory.join(format!("{capture_id}.png"));
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .map_err(|e| format!("PNG encode error: {e}"))?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Failed to create screenshot: {e}"))?;
        file.write_all(&png)
            .map_err(|e| format!("Failed to save screenshot: {e}"))?;
        let artifact = ScreenshotArtifact {
            capture_id: capture_id.clone(),
            path: path.to_string_lossy().into_owned(),
            source,
            x,
            y,
            width: image.width(),
            height: image.height(),
            created_at_unix_ms,
            bytes: png.len() as u64,
        };
        self.artifacts
            .lock()
            .map_err(|_| "Screenshot store lock was poisoned".to_string())?
            .insert(capture_id, artifact.clone());
        Ok(artifact)
    }

    pub fn get(&self, capture_id: &str) -> Result<ScreenshotArtifact, String> {
        self.cleanup_expired()?;
        let artifact = self
            .artifacts
            .lock()
            .map_err(|_| "Screenshot store lock was poisoned".to_string())?
            .get(capture_id)
            .cloned()
            .ok_or_else(|| format!("Screenshot '{capture_id}' was not found or has expired"))?;
        if !PathBuf::from(&artifact.path).is_file() {
            return Err(format!("Screenshot '{capture_id}' is no longer available"));
        }
        Ok(artifact)
    }

    pub fn delete(&self, capture_id: &str) -> Result<bool, String> {
        let artifact = self
            .artifacts
            .lock()
            .map_err(|_| "Screenshot store lock was poisoned".to_string())?
            .remove(capture_id);
        let Some(artifact) = artifact else {
            return Ok(false);
        };
        match fs::remove_file(&artifact.path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(e) => Err(format!("Failed to delete screenshot: {e}")),
        }
    }

    fn cleanup_expired(&self) -> Result<(), String> {
        let cutoff = now_ms().saturating_sub(RETENTION.as_millis());
        let expired = {
            let mut artifacts = self
                .artifacts
                .lock()
                .map_err(|_| "Screenshot store lock was poisoned".to_string())?;
            let ids = artifacts
                .iter()
                .filter(|(_, item)| item.created_at_unix_ms < cutoff)
                .map(|(id, item)| (id.clone(), item.path.clone()))
                .collect::<Vec<_>>();
            for (id, _) in &ids {
                artifacts.remove(id);
            }
            ids
        };
        for (_, path) in expired {
            if let Err(e) = fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("Failed to clean up expired screenshot: {e}"));
                }
            }
        }
        self.cleanup_directory()?;
        Ok(())
    }

    fn cleanup_directory(&self) -> Result<(), String> {
        let directory = artifact_dir()?;
        if !directory.is_dir() {
            return Ok(());
        }
        let now = SystemTime::now();
        let mut remaining = Vec::new();
        for entry in fs::read_dir(&directory)
            .map_err(|e| format!("Failed to inspect screenshot directory: {e}"))?
        {
            let entry = entry.map_err(|e| format!("Failed to inspect screenshot entry: {e}"))?;
            let path = entry.path();
            if path.extension().and_then(|item| item.to_str()) != Some("png") {
                continue;
            }
            let metadata = entry
                .metadata()
                .map_err(|e| format!("Failed to inspect screenshot metadata: {e}"))?;
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            if now.duration_since(modified).unwrap_or_default() > RETENTION {
                let _ = fs::remove_file(path);
            } else {
                remaining.push((path, modified, metadata.len()));
            }
        }
        remaining.sort_by_key(|(_, modified, _)| *modified);
        let mut total = remaining.iter().map(|(_, _, bytes)| *bytes).sum::<u64>();
        for (path, _, bytes) in remaining {
            if total <= MAX_TOTAL_BYTES {
                break;
            }
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to enforce screenshot storage limit: {e}"))?;
            total = total.saturating_sub(bytes);
        }
        Ok(())
    }
}

fn artifact_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .map(|path| path.join("CloverViewer").join("mcp-captures"))
        .ok_or_else(|| "Cannot determine a local data directory".to_string())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

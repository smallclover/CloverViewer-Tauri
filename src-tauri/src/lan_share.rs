//! Short-lived, token-protected LAN sharing for a single screenshot.
//!
//! The HTTP listener never exposes the file system: it serves only the PNG held
//! in memory for the active share, and shuts down after its TTL or an explicit
//! stop command.

use crate::config::ConfigStore;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use base64::Engine;
use image::{codecs::jpeg::JpegEncoder, GenericImageView};
use qrcodegen::{QrCode, QrCodeEcc};
use serde::Serialize;
use std::{
    net::{IpAddr, Ipv4Addr, UdpSocket},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

const MAX_SHARE_BYTES: usize = 25 * 1024 * 1024;
const MAX_PREVIEW_EDGE: u32 = 4096;

#[derive(Clone)]
pub struct LanShareStore {
    active: Arc<Mutex<Option<ActiveLanShare>>>,
}

struct ActiveLanShare {
    token: String,
    data: Arc<Vec<u8>>,
    mime: &'static str,
    filename: String,
    expires_at: Instant,
    download_limit: u32,
    downloads: u32,
    shutdown: oneshot::Sender<()>,
}

#[derive(Serialize)]
pub struct LanShareInfo {
    pub url: String,
    pub qr_code: String,
    pub expires_in_seconds: u64,
    pub download_limit: u32,
}

impl LanShareStore {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub fn stop(&self) {
        if let Some(active) = self.active.lock().unwrap().take() {
            let _ = active.shutdown.send(());
        }
    }

    fn stop_token(&self, token: &str) {
        let mut active = self.active.lock().unwrap();
        if active.as_ref().is_some_and(|share| share.token == token) {
            if let Some(share) = active.take() {
                let _ = share.shutdown.send(());
            }
        }
    }

    fn get(&self, token: &str) -> Option<SharedImage> {
        let mut active = self.active.lock().unwrap();
        let share = active.as_ref()?;
        if share.token == token && share.expires_at > Instant::now() {
            return Some(SharedImage {
                data: Arc::clone(&share.data),
                mime: share.mime,
                filename: share.filename.clone(),
            });
        }
        if share.expires_at <= Instant::now() {
            if let Some(expired) = active.take() {
                let _ = expired.shutdown.send(());
            }
        }
        None
    }

    /// Records only explicit `/download` requests. The preview `<img>` uses a
    /// separate endpoint, so viewing a QR link never consumes a one-download share.
    fn take_download(&self, token: &str) -> Option<SharedImage> {
        let mut active = self.active.lock().unwrap();
        let share = active.as_mut()?;
        if share.token != token || share.expires_at <= Instant::now() {
            return None;
        }
        let asset = SharedImage {
            data: Arc::clone(&share.data),
            mime: share.mime,
            filename: share.filename.clone(),
        };
        share.downloads += 1;
        if share.download_limit != 0 && share.downloads >= share.download_limit {
            if let Some(expired) = active.take() {
                let _ = expired.shutdown.send(());
            }
        }
        Some(asset)
    }
}

struct SharedImage {
    data: Arc<Vec<u8>>,
    mime: &'static str,
    filename: String,
}

fn token() -> String {
    // The OS-provided random source is used through a UUID-like 256-bit value;
    // do not derive share URLs from a port or timestamp alone.
    let mut bytes = [0u8; 32];
    for chunk in bytes.chunks_mut(8) {
        let random = rand::random::<u64>().to_le_bytes();
        chunk.copy_from_slice(&random);
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn lan_address() -> Result<Ipv4Addr, String> {
    // UDP connect selects the active outbound adapter without sending a packet.
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
    socket
        .connect((Ipv4Addr::new(1, 1, 1, 1), 80))
        .map_err(|e| format!("无法确定局域网地址: {e}"))?;
    match socket.local_addr().map_err(|e| e.to_string())?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Ok(ip),
        _ => Err("未找到可用于局域网分享的 IPv4 地址".to_string()),
    }
}

fn qr_code_data_url(text: &str) -> Result<String, String> {
    let qr = QrCode::encode_text(text, QrCodeEcc::Medium).map_err(|e| e.to_string())?;
    let border = 4;
    let size = qr.size() + border * 2;
    let mut path = String::new();
    for y in 0..qr.size() {
        for x in 0..qr.size() {
            if qr.get_module(x, y) {
                path.push_str(&format!("M{} {}h1v1h-1z", x + border, y + border));
            }
        }
    }
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\"><rect width=\"100%\" height=\"100%\" fill=\"white\"/><path d=\"{path}\" fill=\"black\"/></svg>"
    );
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    ))
}

fn share_duration(seconds: u32) -> Duration {
    match seconds {
        60 | 300 | 600 | 1800 | 3600 => Duration::from_secs(seconds.into()),
        _ => Duration::from_secs(10 * 60),
    }
}

fn download_limit(value: u32) -> u32 {
    if value == 1 {
        1
    } else {
        0
    }
}

#[tauri::command]
pub async fn start_lan_share(
    store: tauri::State<'_, LanShareStore>,
    config: tauri::State<'_, ConfigStore>,
    png: String,
) -> Result<LanShareInfo, String> {
    let png = base64::engine::general_purpose::STANDARD
        .decode(png.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| format!("截图数据无效: {e}"))?;
    if png.len() > MAX_SHARE_BYTES {
        return Err("截图过大，局域网分享最多支持 25 MB".to_string());
    }
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("局域网分享仅支持 PNG 截图".to_string());
    }

    start_share(&store, &config, png, "image/png", "screenshot", "png").await
}

/// Share the current viewer image as a browser-compatible JPEG preview. The
/// original file never becomes a network path or an HTTP file-system resource.
#[tauri::command]
pub async fn start_image_lan_share(
    store: tauri::State<'_, LanShareStore>,
    config: tauri::State<'_, ConfigStore>,
    path: String,
) -> Result<LanShareInfo, String> {
    let source = image::open(&path).map_err(|e| format!("无法读取图片: {e}"))?;
    let (width, height) = source.dimensions();
    let preview = if width.max(height) > MAX_PREVIEW_EDGE {
        source.thumbnail(MAX_PREVIEW_EDGE, MAX_PREVIEW_EDGE)
    } else {
        source
    };
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&preview)
        .map_err(|e| format!("无法生成分享预览图: {e}"))?;
    start_share(&store, &config, jpeg, "image/jpeg", "image_preview", "jpg").await
}

async fn start_share(
    store: &LanShareStore,
    config: &ConfigStore,
    data: Vec<u8>,
    mime: &'static str,
    filename_prefix: &str,
    extension: &str,
) -> Result<LanShareInfo, String> {
    if data.len() > MAX_SHARE_BYTES {
        return Err("分享文件过大，局域网分享最多支持 25 MB".to_string());
    }
    let config = config.snapshot();
    let ttl = share_duration(config.lan_share_duration_seconds);
    let download_limit = download_limit(config.lan_share_download_limit);
    store.stop();
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|e| format!("无法启动局域网分享服务: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let address = lan_address()?;
    let token = token();
    let url = format!("http://{address}:{port}/s/{token}");
    let qr_code = qr_code_data_url(&url)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let filename = format!(
        "{filename_prefix}_{timestamp}_{}.{}",
        &token[..8],
        extension
    );
    let (shutdown, receiver) = oneshot::channel();
    {
        let mut active = store.active.lock().unwrap();
        *active = Some(ActiveLanShare {
            token: token.clone(),
            data: Arc::new(data),
            mime,
            filename,
            expires_at: Instant::now() + ttl,
            download_limit,
            downloads: 0,
            shutdown,
        });
    }

    let app = Router::new()
        .route("/s/{token}", get(share_page))
        .route("/s/{token}/image", get(share_image))
        .route("/s/{token}/download", get(download_image))
        .with_state(store.inner_clone());
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = receiver.await;
            })
            .await;
    });

    let expiry_store = store.inner_clone();
    std::thread::spawn(move || {
        std::thread::sleep(ttl);
        expiry_store.stop_token(&token);
    });

    Ok(LanShareInfo {
        url,
        qr_code,
        expires_in_seconds: ttl.as_secs(),
        download_limit,
    })
}

#[tauri::command]
pub fn stop_lan_share(store: tauri::State<'_, LanShareStore>) {
    store.stop();
}

impl LanShareStore {
    fn inner_clone(&self) -> Self {
        self.clone()
    }
}

async fn share_page(State(store): State<LanShareStore>, Path(token): Path<String>) -> Response {
    let Some(asset) = store.get(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let image_url = format!("/s/{token}/image");
    let download_url = format!("/s/{token}/download");
    Html(format!(
        "<!doctype html><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Shared screenshot</title><style>body{{margin:0;background:#17191f;color:#eef0f4;font:16px system-ui;text-align:center}}main{{max-width:1100px;margin:auto;padding:24px}}img{{max-width:100%;height:auto;border-radius:8px}}a{{display:inline-block;margin:16px;padding:10px 16px;background:#4ea85c;color:white;border-radius:8px;text-decoration:none}}</style><main><img src=\"{image_url}\" alt=\"Shared screenshot\"><br><a href=\"{download_url}\" download=\"{}\">Download image</a></main>",
        asset.filename
    ))
    .into_response()
}

async fn share_image(State(store): State<LanShareStore>, Path(token): Path<String>) -> Response {
    let Some(asset) = store.get(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::new(Body::from((*asset.data).clone()));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(asset.mime));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::try_from(format!("inline; filename=\"{}\"", asset.filename))
            .expect("share filename must be a valid HTTP header"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn download_image(State(store): State<LanShareStore>, Path(token): Path<String>) -> Response {
    let Some(asset) = store.take_download(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::new(Body::from((*asset.data).clone()));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(asset.mime));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::try_from(format!("attachment; filename=\"{}\"", asset.filename))
            .expect("share filename must be a valid HTTP header"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_is_url_safe_and_unique() {
        let first = token();
        let second = token();
        assert_eq!(first.len(), 43);
        assert_ne!(first, second);
        assert!(first
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
    }

    #[test]
    fn qr_is_an_embeddable_image() {
        assert!(qr_code_data_url("http://192.168.1.2:1234/s/token")
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
    }
}

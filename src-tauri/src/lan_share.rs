//! 单张截图的短时、带令牌局域网分享。
//!
//! HTTP 监听端从不暴露文件系统：它只提供当前分享常驻内存里的 PNG，
//! 到达有效期或收到显式停止命令后就关闭服务。

use crate::config::ConfigStore;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::Engine;
use image::{codecs::jpeg::JpegEncoder, GenericImageView};
use qrcodegen::{QrCode, QrCodeEcc};
use serde::Serialize;
use std::{
    net::{IpAddr, Ipv4Addr, UdpSocket},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

const MAX_SHARE_BYTES: usize = 25 * 1024 * 1024;
const MAX_PREVIEW_EDGE: u32 = 4096;

#[derive(Clone)]
pub struct LanShareStore {
    active: Arc<Mutex<Option<ActiveLanShare>>>,
    generation: Arc<AtomicU64>,
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
    pub share_id: String,
    pub url: String,
    pub qr_code: String,
    pub expires_in_seconds: u64,
    pub download_limit: u32,
}

impl LanShareStore {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn stop(&self) {
        let mut active = self.active.lock().unwrap();
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(active) = active.take() {
            let _ = active.shutdown.send(());
        }
    }

    fn begin_request(&self) -> u64 {
        let _active = self.active.lock().unwrap();
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
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
            return Some(share.snapshot());
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
        let asset = share.snapshot();
        share.downloads += 1;
        if share.download_limit != 0 && share.downloads >= share.download_limit {
            if let Some(expired) = active.take() {
                let _ = expired.shutdown.send(());
            }
        }
        Some(asset)
    }
}

pub(super) struct SharedImage {
    pub(super) data: Arc<Vec<u8>>,
    pub(super) mime: &'static str,
    pub(super) filename: String,
    pub(super) expires_in_seconds: u64,
    pub(super) downloads_remaining: Option<u32>,
}

impl ActiveLanShare {
    fn snapshot(&self) -> SharedImage {
        SharedImage {
            data: Arc::clone(&self.data),
            mime: self.mime,
            filename: self.filename.clone(),
            expires_in_seconds: self
                .expires_at
                .saturating_duration_since(Instant::now())
                .as_secs_f64()
                .ceil() as u64,
            downloads_remaining: (self.download_limit != 0)
                .then(|| self.download_limit.saturating_sub(self.downloads)),
        }
    }
}

fn token() -> String {
    // 用系统随机源生成类 UUID 的 256 位值，
    // 不能只靠端口或时间戳推导分享 URL。
    let mut bytes = [0u8; 32];
    for chunk in bytes.chunks_mut(8) {
        let random = rand::random::<u64>().to_le_bytes();
        chunk.copy_from_slice(&random);
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn lan_address() -> Result<Ipv4Addr, String> {
    // UDP connect 会选中当前活动的出站网卡，且不发送任何数据包。
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
    let request = store.begin_request();
    let png = base64::engine::general_purpose::STANDARD
        .decode(png.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| format!("截图数据无效: {e}"))?;
    if png.len() > MAX_SHARE_BYTES {
        return Err("截图过大，局域网分享最多支持 25 MB".to_string());
    }
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("局域网分享仅支持 PNG 截图".to_string());
    }

    start_share(
        &store,
        &config,
        png,
        "image/png",
        "screenshot",
        "png",
        request,
    )
    .await
}

/// 把查看器当前图片转成浏览器可用的 JPEG 预览来分享。
/// 原文件不会变成网络路径，也不会成为 HTTP 文件系统资源。
#[tauri::command]
pub async fn start_image_lan_share(
    store: tauri::State<'_, LanShareStore>,
    config: tauri::State<'_, ConfigStore>,
    path: String,
    png: Option<String>,
) -> Result<LanShareInfo, String> {
    let request = store.begin_request();
    let jpeg = crate::image_tasks::run(move || {
        let source = crate::image_io::read_pixels(&path, png.as_deref())
            .map_err(|e| format!("无法读取图片: {e}"))?;
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
        Ok(jpeg)
    })
    .await?;
    start_share(
        &store,
        &config,
        jpeg,
        "image/jpeg",
        "image_preview",
        "jpg",
        request,
    )
    .await
}

async fn start_share(
    store: &LanShareStore,
    config: &ConfigStore,
    data: Vec<u8>,
    mime: &'static str,
    filename_prefix: &str,
    extension: &str,
    request: u64,
) -> Result<LanShareInfo, String> {
    if data.len() > MAX_SHARE_BYTES {
        return Err("分享文件过大，局域网分享最多支持 25 MB".to_string());
    }
    let config = config.snapshot();
    let ttl = share_duration(config.lan_share_duration_seconds);
    let download_limit = download_limit(config.lan_share_download_limit);
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
        if store.generation.load(Ordering::SeqCst) != request {
            return Err("Share request was cancelled".into());
        }
        if let Some(previous) = active.take() {
            let _ = previous.shutdown.send(());
        }
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
        .route("/s/{token}/status", get(share_status))
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
    let expiry_token = token.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ttl).await;
        expiry_store.stop_token(&expiry_token);
    });

    Ok(LanShareInfo {
        share_id: token,
        url,
        qr_code,
        expires_in_seconds: ttl.as_secs(),
        download_limit,
    })
}

#[tauri::command]
pub fn is_lan_share_active(store: tauri::State<'_, LanShareStore>, share_id: String) -> bool {
    store.get(&share_id).is_some()
}

#[tauri::command]
pub fn stop_lan_share(store: tauri::State<'_, LanShareStore>, share_id: Option<String>) {
    if let Some(id) = share_id {
        store.stop_token(&id);
    } else {
        store.stop();
    }
}

impl LanShareStore {
    fn inner_clone(&self) -> Self {
        self.clone()
    }
}

async fn share_page(State(store): State<LanShareStore>, Path(token): Path<String>) -> Response {
    let asset = store.get(&token);
    let status = if asset.is_some() {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    let mut response = (
        status,
        Html(crate::lan_share_page::render(&token, asset.as_ref())),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Serialize)]
struct ShareStatus {
    active: bool,
    expires_in_seconds: u64,
    downloads_remaining: Option<u32>,
}

async fn share_status(State(store): State<LanShareStore>, Path(token): Path<String>) -> Response {
    let asset = store.get(&token);
    let mut response = Json(ShareStatus {
        active: asset.is_some(),
        expires_in_seconds: asset.as_ref().map_or(0, |image| image.expires_in_seconds),
        downloads_remaining: asset.and_then(|image| image.downloads_remaining),
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
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
    fn one_download_share_stays_active_for_previews_and_expires_after_the_download() {
        let store = LanShareStore::new();
        let (shutdown, _) = oneshot::channel();
        *store.active.lock().unwrap() = Some(ActiveLanShare {
            token: "single".into(),
            data: Arc::new(vec![1]),
            mime: "image/png",
            filename: "test.png".into(),
            expires_at: Instant::now() + Duration::from_secs(60),
            download_limit: 1,
            downloads: 0,
            shutdown,
        });
        assert!(store.get("single").is_some());
        assert!(store.get("single").is_some());
        assert!(store.take_download("single").is_some());
        assert!(store.get("single").is_none());
        assert!(store.take_download("single").is_none());
    }

    #[tokio::test]
    async fn receiver_status_and_page_do_not_consume_the_download_limit() {
        let store = LanShareStore::new();
        let (shutdown, _) = oneshot::channel();
        *store.active.lock().unwrap() = Some(ActiveLanShare {
            token: "receiver".into(),
            data: Arc::new(vec![1, 2, 3]),
            mime: "image/png",
            filename: "receiver.png".into(),
            expires_at: Instant::now() + Duration::from_secs(60),
            download_limit: 1,
            downloads: 0,
            shutdown,
        });
        let status = share_status(State(store.clone()), Path("receiver".into())).await;
        assert_eq!(status.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = axum::body::to_bytes(status.into_body(), 4096)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["active"], true);
        assert_eq!(value["downloads_remaining"], 1);
        let page = share_page(State(store.clone()), Path("receiver".into())).await;
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
        assert!(store.take_download("receiver").is_some());
        let expired = share_page(State(store.clone()), Path("receiver".into())).await;
        assert_eq!(expired.status(), StatusCode::NOT_FOUND);
        assert!(store.get("receiver").is_none());
    }

    #[test]
    fn stale_stop_cannot_revoke_a_new_share_and_global_stop_cancels_pending_requests() {
        let store = LanShareStore::new();
        let first = store.begin_request();
        let latest = store.begin_request();
        assert_ne!(first, latest);
        let (shutdown, _) = oneshot::channel();
        *store.active.lock().unwrap() = Some(ActiveLanShare {
            token: "latest".into(),
            data: Arc::new(vec![1]),
            mime: "image/png",
            filename: "test.png".into(),
            expires_at: Instant::now() + Duration::from_secs(60),
            download_limit: 0,
            downloads: 0,
            shutdown,
        });
        store.stop_token("old");
        assert!(store.get("latest").is_some());
        store.stop();
        assert!(store.get("latest").is_none());
        assert_ne!(store.generation.load(Ordering::SeqCst), latest);
    }

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

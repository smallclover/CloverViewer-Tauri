//! MCP tools for capture, retrieval, and OCR. They run without the Tauri UI.

mod artifact_store;
mod capture;

use artifact_store::{ArtifactStore, ScreenshotArtifact};
use base64::Engine;
use image::{DynamicImage, ImageFormat};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::*;
use rmcp::schemars;
use rmcp::service::ServiceExt;
use rmcp::{tool, tool_router};
use serde::Deserialize;
use serde_json::json;
use std::{io::Cursor, sync::Arc};

const MAX_RETURN_WIDTH: u32 = 1920;
const MAX_RETURN_PIXELS: u64 = 12_000_000;

#[derive(Clone)]
pub struct CloverMcpServer {
    artifacts: Arc<ArtifactStore>,
}

impl CloverMcpServer {
    pub fn new() -> Self {
        Self {
            artifacts: Arc::new(ArtifactStore::default()),
        }
    }
}

impl Default for CloverMcpServer {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
struct RegionParams {
    /// Virtual-desktop physical pixel coordinate. Negative x/y values are supported.
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ScreenshotParams {
    /// `active_window` (default), `monitor`, `all_monitors`, or `region`.
    mode: Option<String>,
    /// Legacy display index. Use `monitor_id` after calling `list_monitors` when possible.
    monitor_index: Option<u64>,
    /// Stable-for-the-current-desktop display ID returned by `list_monitors`.
    monitor_id: Option<u32>,
    /// Region to capture when mode is `region`; it must be contained by one display.
    region: Option<RegionParams>,
    /// `image` (default) returns MCP image data; `path` returns a local compatibility path; `both` returns both.
    delivery: Option<String>,
    /// Maximum returned image width. Applies only to image/both and is capped at 1920 pixels.
    max_width: Option<u32>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct CaptureIdParams {
    capture_id: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct GetScreenshotParams {
    capture_id: String,
    /// `image` (default), `path`, or `both`.
    delivery: Option<String>,
    max_width: Option<u32>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct OcrParams {
    capture_id: String,
    /// OCR preference: `zh`, `en`, or `ja`. The system language is used when omitted.
    language: Option<String>,
}

#[tool_router(server_handler)]
impl CloverMcpServer {
    #[tool(
        name = "list_monitors",
        description = "List monitors with their current IDs, indexes, virtual-desktop bounds, and scale factors. Use monitor_id with take_screenshot for an explicit display."
    )]
    async fn list_monitors(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        let monitors = tokio::task::spawn_blocking(capture::list_monitors)
            .await
            .map_err(join_error)?
            .map_err(internal_error)?;
        Ok(CallToolResult::structured(json!({ "monitors": monitors })))
    }

    #[tool(
        name = "take_screenshot",
        description = "Capture an active window, monitor, all monitors, or one on-screen region. Images are returned directly by default for vision-capable clients; use delivery='path' only when the client can access the MCP server's local filesystem."
    )]
    async fn take_screenshot(
        &self,
        Parameters(params): Parameters<ScreenshotParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let delivery = Delivery::parse(params.delivery.as_deref())?;
        let max_width = normalized_width(params.max_width)?;
        validate_screenshot_params(&params)?;
        let captures = tokio::task::spawn_blocking(move || capture_from_params(params))
            .await
            .map_err(join_error)?
            .map_err(internal_error)?;

        let store = Arc::clone(&self.artifacts);
        let artifacts = tokio::task::spawn_blocking(move || {
            captures
                .into_iter()
                .map(|capture| {
                    store.save(
                        DynamicImage::ImageRgba8(capture.image),
                        capture.source,
                        capture.x,
                        capture.y,
                    )
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .await
        .map_err(join_error)?
        .map_err(internal_error)?;
        result_for_artifacts(artifacts, delivery, max_width)
    }

    #[tool(
        name = "get_screenshot",
        description = "Retrieve a screenshot created earlier in the current MCP server process. Screenshot IDs expire after 24 hours."
    )]
    async fn get_screenshot(
        &self,
        Parameters(params): Parameters<GetScreenshotParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let delivery = Delivery::parse(params.delivery.as_deref())?;
        let max_width = normalized_width(params.max_width)?;
        let artifact = self
            .artifacts
            .get(&params.capture_id)
            .map_err(internal_error)?;
        result_for_artifacts(vec![artifact], delivery, max_width)
    }

    #[tool(
        name = "delete_screenshot",
        description = "Delete a screenshot created by this MCP server in the current process."
    )]
    async fn delete_screenshot(
        &self,
        Parameters(CaptureIdParams { capture_id }): Parameters<CaptureIdParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let deleted = self.artifacts.delete(&capture_id).map_err(internal_error)?;
        Ok(CallToolResult::structured(
            json!({ "captureId": capture_id, "deleted": deleted }),
        ))
    }

    #[tool(
        name = "ocr_screenshot",
        description = "Recognize text in a previously captured screenshot. The screenshot must have been created by this MCP server in the current process."
    )]
    async fn ocr_screenshot(
        &self,
        Parameters(OcrParams {
            capture_id,
            language,
        }): Parameters<OcrParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let artifact = self.artifacts.get(&capture_id).map_err(internal_error)?;
        let language = parse_language(language.as_deref())?;
        let text = tokio::task::spawn_blocking(move || {
            let image = image::open(&artifact.path)
                .map_err(|e| format!("Failed to read screenshot: {e}"))?;
            crate::ocr::recognize_text(image, language)
        })
        .await
        .map_err(join_error)?
        .map_err(internal_error)?;
        Ok(CallToolResult::structured(
            json!({ "captureId": capture_id, "text": text }),
        ))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Delivery {
    Path,
    Image,
    Both,
}

impl Delivery {
    fn parse(value: Option<&str>) -> Result<Self, rmcp::ErrorData> {
        match value {
            None | Some("image") => Ok(Self::Image),
            Some("path") => Ok(Self::Path),
            Some("both") => Ok(Self::Both),
            Some(other) => Err(invalid_input(format!(
                "Unknown delivery '{other}'. Expected path, image, or both"
            ))),
        }
    }
}

fn validate_screenshot_params(params: &ScreenshotParams) -> Result<(), rmcp::ErrorData> {
    let has_monitor_target = params.monitor_id.is_some() || params.monitor_index.is_some();
    if params.monitor_id.is_some() && params.monitor_index.is_some() {
        return Err(invalid_input(
            "Specify either monitor_id or monitor_index, not both".to_string(),
        ));
    }

    if let Some(region) = &params.region {
        if params.mode.as_deref() != Some("region") || has_monitor_target {
            return Err(invalid_input(
                "region requires mode='region' and cannot be combined with a monitor target"
                    .to_string(),
            ));
        }
        if region.width == 0 || region.height == 0 {
            return Err(invalid_input(
                "Region width and height must be greater than zero".to_string(),
            ));
        }
        return Ok(());
    }

    match params.mode.as_deref() {
        Some("active_window") if has_monitor_target => Err(invalid_input(
            "active_window cannot be combined with a monitor target".to_string(),
        )),
        Some("monitor") if !has_monitor_target => Err(invalid_input(
            "monitor_id or monitor_index is required when mode='monitor'".to_string(),
        )),
        Some("all_monitors") if has_monitor_target => Err(invalid_input(
            "all_monitors cannot be combined with a monitor target".to_string(),
        )),
        Some("region") => Err(invalid_input(
            "region is required when mode='region'".to_string(),
        )),
        Some("active_window") | Some("monitor") | Some("all_monitors") | None => Ok(()),
        Some(other) => Err(invalid_input(format!("Unknown mode '{other}'"))),
    }
}

fn capture_from_params(params: ScreenshotParams) -> Result<Vec<capture::CapturedImage>, String> {
    let mode = params.mode.as_deref();
    if params.monitor_id.is_some() && params.monitor_index.is_some() {
        return Err("Specify either monitor_id or monitor_index, not both".to_string());
    }
    if let Some(region) = params.region {
        if mode.is_some_and(|value| value != "region")
            || params.monitor_id.is_some()
            || params.monitor_index.is_some()
        {
            return Err("region may only be used with mode='region' and cannot be combined with a monitor target".to_string());
        }
        return capture::capture_region(region.x, region.y, region.width, region.height)
            .map(|item| vec![item]);
    }
    match mode {
        Some("active_window") => capture::capture_active_window().map(|item| vec![item]),
        Some("monitor") => match (params.monitor_id, params.monitor_index) {
            (Some(id), None) => capture::capture_monitor_by_id(id).map(|item| vec![item]),
            (None, Some(index)) => capture::capture_monitor(index as usize).map(|item| vec![item]),
            (None, None) => {
                Err("monitor_id or monitor_index is required when mode='monitor'".to_string())
            }
            _ => unreachable!(),
        },
        Some("all_monitors") => {
            if params.monitor_id.is_some() || params.monitor_index.is_some() {
                Err("all_monitors cannot be combined with a monitor target".to_string())
            } else {
                capture::capture_all_monitors()
            }
        }
        Some("region") => Err("region is required when mode='region'".to_string()),
        Some(other) => Err(format!("Unknown mode '{other}'")),
        None => match (params.monitor_id, params.monitor_index) {
            (Some(id), None) => capture::capture_monitor_by_id(id).map(|item| vec![item]),
            (None, Some(index)) => capture::capture_monitor(index as usize).map(|item| vec![item]),
            (None, None) => capture::capture_active_window().map(|item| vec![item]),
            _ => unreachable!(),
        },
    }
}

fn result_for_artifacts(
    artifacts: Vec<ScreenshotArtifact>,
    delivery: Delivery,
    max_width: u32,
) -> Result<CallToolResult, rmcp::ErrorData> {
    if delivery == Delivery::Path {
        return Ok(CallToolResult::success(vec![Content::text(
            artifacts
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        )]));
    }
    // A server-local path can be meaningless to sandboxed MCP clients. Only
    // expose it when the caller explicitly asks for a path-compatible result.
    let metadata = json!({
        "screenshots": artifacts
            .iter()
            .map(|artifact| artifact_metadata(artifact, delivery == Delivery::Both))
            .collect::<Vec<_>>()
    });
    let mut content = vec![Content::text(metadata.to_string())];
    if delivery == Delivery::Image || delivery == Delivery::Both {
        for artifact in &artifacts {
            content.push(Content::image(
                encode_for_response(&artifact.path, max_width)?,
                "image/png",
            ));
        }
    }
    let mut result = CallToolResult::structured(metadata);
    result.content = content;
    Ok(result)
}

fn artifact_metadata(artifact: &ScreenshotArtifact, include_path: bool) -> serde_json::Value {
    let mut value = json!({
        "captureId": artifact.capture_id,
        "source": artifact.source,
        "x": artifact.x,
        "y": artifact.y,
        "width": artifact.width,
        "height": artifact.height,
        "createdAtUnixMs": artifact.created_at_unix_ms,
        "bytes": artifact.bytes,
    });
    if include_path {
        value["path"] = json!(artifact.path);
    }
    value
}

fn encode_for_response(path: &str, max_width: u32) -> Result<String, rmcp::ErrorData> {
    let image =
        image::open(path).map_err(|e| internal_error(format!("Failed to read screenshot: {e}")))?;
    let max_height = (MAX_RETURN_PIXELS / max_width as u64)
        .max(1)
        .min(u32::MAX as u64) as u32;
    let image = image.resize(max_width, max_height, image::imageops::FilterType::Triangle);
    let mut encoded = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
        .map_err(|e| internal_error(format!("PNG encode error: {e}")))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(encoded))
}

fn normalized_width(value: Option<u32>) -> Result<u32, rmcp::ErrorData> {
    match value.unwrap_or(MAX_RETURN_WIDTH) {
        1..=MAX_RETURN_WIDTH => Ok(value.unwrap_or(MAX_RETURN_WIDTH)),
        other => Err(invalid_input(format!(
            "max_width must be between 1 and {MAX_RETURN_WIDTH}; got {other}"
        ))),
    }
}

fn parse_language(value: Option<&str>) -> Result<crate::config::Language, rmcp::ErrorData> {
    match value {
        None => Ok(crate::config::Language::detect_system()),
        Some("zh") => Ok(crate::config::Language::Zh),
        Some("en") => Ok(crate::config::Language::En),
        Some("ja") => Ok(crate::config::Language::Ja),
        Some(other) => Err(invalid_input(format!(
            "Unknown OCR language '{other}'. Expected zh, en, or ja"
        ))),
    }
}

fn join_error(error: tokio::task::JoinError) -> rmcp::ErrorData {
    internal_error(format!("Background task failed: {error}"))
}
fn internal_error(message: String) -> rmcp::ErrorData {
    rmcp::ErrorData::internal_error(message, None)
}
fn invalid_input(message: String) -> rmcp::ErrorData {
    rmcp::ErrorData::invalid_params(message, None)
}

pub fn run_mcp_server() {
    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    rt.block_on(async {
        let running = CloverMcpServer::new()
            .serve(rmcp::transport::io::stdio())
            .await
            .expect("Failed to start MCP server");
        running.waiting().await.expect("MCP server error");
    });
}

pub fn run_mcp_http_server(port: u16, token: String) {
    use axum::{
        extract::{Request, State},
        http::{
            header::{AUTHORIZATION, ORIGIN, WWW_AUTHENTICATE},
            HeaderValue, StatusCode,
        },
        middleware::Next,
        response::{IntoResponse, Response},
    };
    use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
    };

    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    rt.block_on(async {
        let server = CloverMcpServer::new();
        let service = StreamableHttpService::new(
            move || Ok(server.clone()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        );
        async fn validate_request(
            State(token): State<Arc<str>>,
            request: Request,
            next: Next,
        ) -> Response {
            let trusted = request
                .headers()
                .get(ORIGIN)
                .map(|origin| {
                    origin.to_str().ok().is_some_and(|value| {
                        let value = value.to_ascii_lowercase();
                        value == "http://localhost"
                            || value.starts_with("http://localhost:")
                            || value == "http://127.0.0.1"
                            || value.starts_with("http://127.0.0.1:")
                            || value == "http://[::1]"
                            || value.starts_with("http://[::1]:")
                    })
                })
                .unwrap_or(true);
            if !trusted {
                return StatusCode::FORBIDDEN.into_response();
            }
            let authorized = request
                .headers()
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.strip_prefix("Bearer ") == Some(token.as_ref()));
            if authorized {
                next.run(request).await
            } else {
                (
                    StatusCode::UNAUTHORIZED,
                    [(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"))],
                )
                    .into_response()
            }
        }
        let app = axum::Router::new().nest_service("/mcp", service).layer(
            axum::middleware::from_fn_with_state(Arc::<str>::from(token), validate_request),
        );
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .expect("Failed to bind MCP HTTP listener");
        println!("MCP HTTP server listening on http://127.0.0.1:{port}/mcp");
        axum::serve(listener, app)
            .await
            .expect("MCP HTTP server error");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_defaults_to_ai_usable_image_content() {
        assert_eq!(Delivery::parse(None).unwrap(), Delivery::Image);
        assert_eq!(Delivery::parse(Some("image")).unwrap(), Delivery::Image);
        assert_eq!(Delivery::parse(Some("path")).unwrap(), Delivery::Path);
        assert!(Delivery::parse(Some("blob")).is_err());
    }

    #[test]
    fn image_metadata_omits_server_local_path() {
        let artifact = ScreenshotArtifact {
            capture_id: "cv-test".into(),
            path: "C:\\server-only\\capture.png".into(),
            source: "active_window".into(),
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            created_at_unix_ms: 5,
            bytes: 6,
        };
        assert!(artifact_metadata(&artifact, false).get("path").is_none());
        assert_eq!(
            artifact_metadata(&artifact, true)["path"],
            "C:\\server-only\\capture.png"
        );
    }

    #[test]
    fn invalid_target_combinations_fail_before_capture() {
        let missing_monitor_target = ScreenshotParams {
            mode: Some("monitor".into()),
            monitor_index: None,
            monitor_id: None,
            region: None,
            delivery: None,
            max_width: None,
        };
        assert!(validate_screenshot_params(&missing_monitor_target).is_err());

        let conflicting_region = ScreenshotParams {
            mode: None,
            monitor_index: None,
            monitor_id: None,
            region: Some(RegionParams {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            }),
            delivery: None,
            max_width: None,
        };
        assert!(validate_screenshot_params(&conflicting_region).is_err());
    }

    #[test]
    fn returned_image_width_is_bounded() {
        assert_eq!(normalized_width(None).unwrap(), MAX_RETURN_WIDTH);
        assert_eq!(normalized_width(Some(640)).unwrap(), 640);
        assert!(normalized_width(Some(0)).is_err());
        assert!(normalized_width(Some(MAX_RETURN_WIDTH + 1)).is_err());
    }

    #[test]
    fn language_values_are_explicit() {
        assert!(parse_language(Some("zh")).is_ok());
        assert!(parse_language(Some("en-us")).is_err());
    }
}

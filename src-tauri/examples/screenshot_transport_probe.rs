//! Compare the old/new screenshot paths in a hidden, real WebView2 window.
//! Requires built dist; old mode also needs a copy at .unit-test-dist/screenshot-baseline-dist.
//! Run with `png` or `raw`. Captures remain in memory; no files or clipboard writes.
//! Windows cargo examples lack the main executable's resources. Before running, use Windows
//! SDK mt.exe to embed tauri-build's src/windows-app-manifest.xml (from the cargo registry):
//! `mt.exe -manifest <manifest-path> "-outputresource:<probe-exe-path>;#1"`
//! Without this, the process can fail at startup with STATUS_ENTRYPOINT_NOT_FOUND.
use base64::Engine;
use cloverviewer_tauri_lib::screenshot_capture::{capture_all, CapturedScreenshot};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

struct Probe {
    png: bool,
    round: AtomicU64,
    capture: Mutex<Option<CapturedScreenshot>>,
    legacy: Mutex<Option<Value>>,
    started: Mutex<Option<Instant>>,
}

fn queue_capture(app: AppHandle) {
    std::thread::spawn(move || {
        // Allow the initial page load / previous clear callback to finish before timing.
        std::thread::sleep(Duration::from_millis(200));
        let probe = app.state::<Probe>();
        let round = probe.round.fetch_add(1, Ordering::SeqCst) + 1;
        *probe.started.lock().unwrap() = Some(Instant::now());
        let capture = capture_all(round).expect("desktop capture");
        if let Some(window) = app.get_webview_window("screenshot") {
            let _ = window.set_size(tauri::PhysicalSize::new(
                capture.data.total_width,
                capture.data.total_height,
            ));
        }
        if probe.png {
            let mut legacy = serde_json::to_value(&capture.data).unwrap();
            for (index, screen) in capture.data.screens.iter().enumerate() {
                let frame = capture.frame(round, index).unwrap();
                let mut png = Vec::new();
                PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::NoFilter)
                    .write_image(
                        frame.as_slice(),
                        screen.width,
                        screen.height,
                        ExtendedColorType::Rgba8,
                    )
                    .unwrap();
                legacy["screens"][index]["data_url"] = json!(format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(png)
                ));
            }
            *probe.legacy.lock().unwrap() = Some(legacy);
        }
        *probe.capture.lock().unwrap() = Some(capture);
        app.emit("screenshot-refresh", ()).unwrap();
    });
}

#[tauri::command]
fn get_config() -> Value {
    json!({"theme":"dark", "language":"Zh", "magnifier_enabled":false, "experimental_auto_scroll":false})
}

#[tauri::command]
fn get_screenshot_data(app: AppHandle) -> Option<Value> {
    let probe = app.state::<Probe>();
    if probe.round.load(Ordering::SeqCst) == 0 {
        queue_capture(app.clone());
    }
    if probe.png {
        probe.legacy.lock().unwrap().clone()
    } else {
        probe
            .capture
            .lock()
            .unwrap()
            .as_ref()
            .map(|capture| serde_json::to_value(&capture.data).unwrap())
    }
}

#[tauri::command]
async fn get_screenshot_frame(
    app: AppHandle,
    capture_id: u64,
    screen_index: usize,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let probe = app.state::<Probe>();
        let frame = probe
            .capture
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("No capture")?
            .frame(capture_id, screen_index)?;
        Ok(tauri::ipc::Response::new(frame.as_ref().clone()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn screenshot_ui_ready(app: AppHandle, capture_id: Option<u64>) -> bool {
    let probe = app.state::<Probe>();
    let round = probe.round.load(Ordering::SeqCst);
    if let Some(started) = probe.started.lock().unwrap().take() {
        println!(
            "mode={} round={round} capture_to_ready_ms={:.1} capture_id={capture_id:?}",
            if probe.png { "png" } else { "raw" },
            started.elapsed().as_secs_f64() * 1000.0
        );
        if round >= 4 {
            app.exit(0);
        } else {
            *probe.capture.lock().unwrap() = None;
            *probe.legacy.lock().unwrap() = None;
            app.emit("screenshot-clear", ()).unwrap();
            queue_capture(app.clone());
        }
    }
    true
}

#[tauri::command]
fn discard_scroll_capture() {}
#[tauri::command]
fn scroll_capture_running() -> bool {
    false
}
#[tauri::command]
fn take_scroll_start_mode() -> bool {
    false
}

fn main() {
    cloverviewer_tauri_lib::scroll_capture::ensure_dpi_aware();
    let png = std::env::args().nth(1).as_deref() == Some("png");
    let assets = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(if png {
        "../.unit-test-dist/screenshot-baseline-dist"
    } else {
        "../dist"
    });
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .manage(Probe {
            png,
            round: AtomicU64::new(0),
            capture: Mutex::new(None),
            legacy: Mutex::new(None),
            started: Mutex::new(None),
        })
        .register_uri_scheme_protocol("probe", move |_context, request| {
            let path = request.uri().path().trim_start_matches('/');
            let mime = if path.ends_with(".js") {
                "text/javascript"
            } else if path.ends_with(".css") {
                "text/css"
            } else {
                "text/html"
            };
            tauri::http::Response::builder()
                .header("Content-Type", mime)
                .body(std::fs::read(assets.join(path)).unwrap_or_default())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_screenshot_data,
            get_screenshot_frame,
            screenshot_ui_ready,
            discard_scroll_capture,
            scroll_capture_running,
            take_scroll_start_mode
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(
                app,
                "screenshot",
                WebviewUrl::CustomProtocol("probe://localhost/screenshot.html".parse().unwrap()),
            )
            .visible(false)
            .focused(false)
            .inner_size(800.0, 600.0)
            .build()?;
            // Never leave a hidden probe process running if a page error prevents completion.
            let app = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(20));
                app.exit(2);
            });
            Ok(())
        })
        .run(context)
        .expect("hidden screenshot transport probe");
}

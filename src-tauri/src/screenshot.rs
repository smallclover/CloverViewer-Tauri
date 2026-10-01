//! 截图覆盖窗 —— 移植自 CloverViewer feature/screenshot/capture 的截屏 + 窗口逻辑。
//!
//! 与 egui 版的关键差异：egui 版复用主窗口 viewport 切换透明态；Tauri 版改为**独立截图窗口**
//! （独立 HWND，规避与主窗口共享 HWND 导致的样式/状态泄漏——Xiangxu 项目已验证的教训）。
//!
//! 性能策略：
//! - **改用 builder API 在 build 阶段一次性设置 position + inner_size**（logical 像素）。
//!   早期版本用 `set_position(PhysicalPosition)` 在 show 后再移动，wry Windows 后端有时不
//!   按 physical 单位消费、外加 OS relayout race，窗口外框偏离 + 内部 viewport 不对齐。
//!   builder 上 `position`/`inner_size` 是 logical，wry 内部按窗口所在 monitor 的 scale
//!   自动换算成 raw pixel 调 SetWindowPos，定位最稳。
//! - 主界面首帧后预建隐藏 WebView，首次 Alt+S 不再承担窗口冷启动；关闭时隐藏复用。
//! - 截屏完成 → 写 store → `emit("screenshot-refresh")`，前端监听后清状态 + 重载截图。
//! - `capturing` 互斥锁避免重叠 Alt+S。
//!
//! 坐标约定：
//! - xcap 的 `Monitor::x()/y()/width()/height()` 在 per-monitor DPI aware 进程下是
//!   **虚拟桌面物理像素**（raw PIXELS），与 `Cursor::position()` 同坐标系统。
//! - Tauri 2 builder 的 `.position(x, y)` 是 logical 像素；换算：logical = physical / scale。

pub use crate::screenshot_capture::CursorPosition;
use crate::screenshot_capture::{capture_all, CapturedScreenshot, ScreenshotData};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};

/// 截图覆盖窗的窗口标签（跨模块共用：界面缩放、滚动截图定位等）。
pub const WINDOW_LABEL: &str = "screenshot";

pub struct ScreenshotStore {
    data: Mutex<Option<CapturedScreenshot>>,
    next_capture_id: AtomicU64,
    capturing: Mutex<bool>,
    pub(crate) window_creation: Mutex<()>,
    capture_started: Mutex<Option<std::time::Instant>>,
    /// 本次进入覆盖窗时的启动模式：true = 直接进「滚动截图待框选」态。
    /// 独立热键（Alt+Shift+S）置位，前端 loadScreenshot 时取走并清掉。
    scroll_start: Mutex<Option<(bool, std::time::Instant)>>,
}

impl ScreenshotStore {
    pub fn new() -> Self {
        Self {
            data: Mutex::new(None),
            next_capture_id: AtomicU64::new(1),
            capturing: Mutex::new(false),
            window_creation: Mutex::new(()),
            capture_started: Mutex::new(None),
            scroll_start: Mutex::new(None),
        }
    }

    /// 前端取走并清除「是否以滚动截图模式启动」
    pub fn take_scroll_start(&self) -> bool {
        let mut g = self.scroll_start.lock().unwrap();
        let v = g.map(|(v, _)| v).unwrap_or(false);
        *g = None;
        v
    }

    /// 记录启动模式。
    ///
    /// 「先写先赢」（窗口 500ms 内）：Alt+Shift+S 与 Alt+S 都可能在同一瞬间触发同一个入口，
    /// 若普通截图那次后到，就会把「滚动截图」意图覆盖掉 —— 现象是按下 Alt+Shift+S 却进了
    /// 普通截图（用户实测报回）。真正的「过一会儿再按 Alt+S」不受影响（超过窗口就正常覆盖）。
    fn set_scroll_start(&self, on: bool) {
        const GUARD: std::time::Duration = std::time::Duration::from_millis(500);
        let mut g = self.scroll_start.lock().unwrap();
        match *g {
            Some((true, t)) if !on && t.elapsed() < GUARD => {
                tracing::info!("启动模式: 保留滚动截图意图（忽略同一瞬间的普通截图触发）");
            }
            _ => *g = Some((on, std::time::Instant::now())),
        }
    }

    /// 占用「正在截图」互斥。滚动截图会话与 Alt+S 共用这一把锁，
    /// 避免一次长截图中途被另一次截图打断（返回 false = 已有截图在进行中）。
    pub fn try_begin_capture(&self) -> bool {
        let mut g = self.capturing.lock().unwrap();
        if *g {
            false
        } else {
            *g = true;
            true
        }
    }

    /// 释放「正在截图」互斥
    pub fn end_capture(&self) {
        *self.capturing.lock().unwrap() = false;
    }
}

/// 截图窗口前端拉取截屏数据
#[tauri::command]
pub fn get_screenshot_data(store: State<'_, ScreenshotStore>) -> Option<ScreenshotData> {
    store
        .data
        .lock()
        .unwrap()
        .as_ref()
        .map(|capture| capture.data.clone())
}

/// Binary IPC bypasses PNG compression, Base64 and JSON pixel serialization.
#[tauri::command]
pub async fn get_screenshot_frame(
    app: AppHandle,
    capture_id: u64,
    screen_index: usize,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<ScreenshotStore>();
        let frame = store
            .data
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("Screenshot session has closed")?
            .frame(capture_id, screen_index)?;
        // The Arc outlives the lock: copying a large frame never blocks metadata/close commands.
        Ok(tauri::ipc::Response::new(frame.as_ref().clone()))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 前端进入截图窗时询问「这次是不是以滚动截图模式启动」，取走即清（一次性）。
#[tauri::command]
pub fn take_scroll_start_mode(store: State<'_, ScreenshotStore>) -> bool {
    store.take_scroll_start()
}

/// 关闭截图窗口（前端 Esc 时调用）—— 仅隐藏窗口（不销毁），保留供下次复用。
#[tauri::command]
pub fn close_screenshot(app: AppHandle, completed: Option<bool>, capture_id: Option<u64>) {
    // A preloaded/reloaded page must never pick up a previously closed screenshot.
    let store = app.state::<ScreenshotStore>();
    let mut capture = store.data.lock().unwrap();
    if capture_id.is_some_and(|id| {
        !capture
            .as_ref()
            .is_some_and(|capture| capture.data.capture_id == id)
    }) {
        return;
    }
    *capture = None;
    drop(capture);
    *store.capture_started.lock().unwrap() = None;
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        // 先让前端清掉画面（移除 body.ready），避免下次 show 时闪旧截图
        let _ = w.emit("screenshot-clear", ());
        let _ = w.hide();
    }
    crate::desktop_pet::restore_after_screenshot(&app);
    if completed.unwrap_or(false) {
        let _ = app.emit("desktop-pet-celebrate", ());
    }
}

/// 复制纯文本到剪贴板（放大镜取色 Ctrl+C 用）
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

/// 复制磁盘上的图片到系统剪贴板。
///
/// 查看器不能依赖 WebView 的 `ClipboardItem`：Windows WebView2 对图片写剪贴板的
/// 支持会随运行环境变化，长截图从查看器打开后尤其容易报错。统一走 arboard，和截图
/// 覆盖窗的图片复制保持同一套原生实现。
#[tauri::command]
pub fn copy_image_file(path: String) -> Result<(), String> {
    let image = image::open(&path)
        .map_err(|e| format!("无法读取图片 {path}: {e}"))?
        .to_rgba8();
    let width = image.width() as usize;
    let height = image.height() as usize;
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width,
            height,
            bytes: std::borrow::Cow::Owned(image.into_raw()),
        })
        .map_err(|e| e.to_string())
}

/// 物理坐标 (x, y) 处的顶层窗口矩形（物理像素）。
/// 用于"绿框跟随鼠标自动框选窗口"：按 Z 序枚举顶层可见窗口，跳过本应用自己的
/// 窗口（截图/主窗口），命中第一个包含该点且最上层的窗口。坐标与 xcap 同一物理像素系。
#[derive(Debug, Clone, Serialize)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn pick_window_at(app: AppHandle, x: i32, y: i32) -> Option<WindowRect> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{HWND, LPARAM, RECT};
        use windows::Win32::Graphics::Dwm::{
            DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetClassNameW, GetWindowRect, IsIconic, IsWindowVisible,
        };

        // 桌面 / 任务栏这类"背景窗口"，光标落到它们上面时不应框选（否则绿框会框到整块屏幕）
        const BG_CLASSES: &[&str] = &[
            "Progman",
            "WorkerW",
            "SHELLDLL_DefView",
            "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd",
            "NotifyIconOverflowWindow",
        ];

        unsafe fn window_class(hwnd: HWND) -> String {
            let mut buf = [0u16; 256];
            let n = GetClassNameW(hwnd, &mut buf);
            if n == 0 {
                String::new()
            } else {
                String::from_utf16_lossy(&buf[..n as usize])
            }
        }

        // 取窗口真实可见边界：优先 DWM 扩展帧边界（去掉不可见 resize 边框），失败回退 GetWindowRect
        unsafe fn window_bounds(hwnd: HWND) -> Option<RECT> {
            let mut r = RECT::default();
            let ok = DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut RECT as *mut core::ffi::c_void,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_ok();
            if ok {
                return Some(r);
            }
            GetWindowRect(hwnd, &mut r).ok()?;
            Some(r)
        }

        unsafe fn is_cloaked(hwnd: HWND) -> bool {
            let mut v: u32 = 0;
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut v as *mut u32 as *mut core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
            .is_ok()
                && v != 0
        }

        // 本应用自己的顶层窗口，枚举时跳过
        let own: Vec<HWND> = {
            let mut v = Vec::new();
            for label in [WINDOW_LABEL, "main"] {
                if let Some(w) = app.get_webview_window(label) {
                    if let Ok(hwnd) = w.hwnd() {
                        // Tauri 的 hwnd() 来自 windows 0.61.3，而本函数 use 的是 0.62.2，
                        // 两个 HWND 均为 #[repr(transparent)] 包装 *mut c_void，用裸指针桥接。
                        v.push(HWND(hwnd.0));
                    }
                }
            }
            v
        };

        struct Ctx {
            x: i32,
            y: i32,
            own: Vec<HWND>,
            found: Option<RECT>,
        }

        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
            let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
            unsafe {
                if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                    return true.into();
                }
                if is_cloaked(hwnd) {
                    return true.into();
                }
                if ctx.own.contains(&hwnd) {
                    return true.into();
                }
                let class = window_class(hwnd);
                if BG_CLASSES.contains(&class.as_str()) {
                    return true.into();
                }
                if let Some(r) = window_bounds(hwnd) {
                    if ctx.x >= r.left && ctx.x < r.right && ctx.y >= r.top && ctx.y < r.bottom {
                        // EnumWindows 按 Z 序顶到底枚举，第一个命中即最上层窗口
                        ctx.found = Some(r);
                        return false.into();
                    }
                }
            }
            true.into()
        }

        let mut ctx = Ctx {
            x,
            y,
            own,
            found: None,
        };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
        }
        ctx.found.map(|r| WindowRect {
            x: r.left,
            y: r.top,
            width: (r.right - r.left).max(1) as u32,
            height: (r.bottom - r.top).max(1) as u32,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, x, y);
        None
    }
}

/// 前端导出完成后的收尾请求：PNG 已由前端 Canvas 合成（裁剪 + 标注），
/// Rust 侧负责「落盘」或「写剪贴板」；普通复制/保存可延后隐藏，让前端先显示确认。
#[derive(Debug, Deserialize)]
pub struct FinishRequest {
    /// "save" | "clipboard" | "open"
    pub action: String,
    /// 前端 `canvas.toBlob` 导出的 PNG（base64，可带 data: 前缀）
    pub png: String,
    /// OCR 成功时随临时图片交给查看器；普通导出不携带文字。
    pub ocr_text: Option<String>,
    /// 复制或保存成功后，先让前端显示短提示，再由前端关闭截图窗口。
    pub defer_close: Option<bool>,
}

#[tauri::command]
pub fn finish_screenshot(app: AppHandle, req: FinishRequest) -> Result<(), String> {
    let b64 = req.png.trim_start_matches("data:image/png;base64,");
    let png = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;

    match req.action.as_str() {
        "save" | "open" => {
            let path = if req.action == "save" {
                let desktop = dirs::desktop_dir().ok_or("未找到桌面目录")?;
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                desktop.join(format!("screenshot_{ts}.png"))
            } else {
                // 与滚动截图一致：只写应用自己的临时目录，供查看器打开。
                let dir = crate::commands::temporary_capture_dir();
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                dir.join(format!("screenshot_{ts}.png"))
            };
            std::fs::write(&path, &png).map_err(|e| e.to_string())?;
            tracing::info!("截图已保存: {}", path.display());
            if req.action == "open" {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.unminimize();
                    let _ = main.set_focus();
                }
                let _ = app.emit(
                    "open-image",
                    serde_json::json!({ "path": path, "ocr_text": req.ocr_text }),
                );
            }
        }
        "clipboard" => {
            let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?
                .to_rgba8();
            let width = img.width() as usize;
            let height = img.height() as usize;
            let bytes = img.into_raw();
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard
                .set_image(arboard::ImageData {
                    width,
                    height,
                    bytes: std::borrow::Cow::Owned(bytes),
                })
                .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("未知动作: {other}")),
    }

    if req.defer_close == Some(true) && matches!(req.action.as_str(), "save" | "clipboard") {
        return Ok(());
    }
    close_screenshot(app, Some(true), None);
    Ok(())
}

/// 进入截图模式：截屏 + 复用/创建截图窗口（由全局热键触发）
pub fn start_screenshot(app: &AppHandle) {
    start_screenshot_mode(app, false);
}

/// 进入滚动截图模式：与普通截图共用覆盖窗与截屏流程，只是进入后直接处于
/// 「滚动截图待框选」态（由 Alt+Shift+S 这类专属热键触发）。
pub fn start_scroll_screenshot(app: &AppHandle) {
    start_screenshot_mode(app, true);
}

fn start_screenshot_mode(app: &AppHandle, scroll: bool) {
    let triggered = std::time::Instant::now();
    let app = app.clone();
    std::thread::spawn(move || {
        let store = app.state::<ScreenshotStore>();
        store.set_scroll_start(scroll);
        tracing::info!(
            "覆盖窗启动: 模式={}",
            if scroll {
                "滚动截图"
            } else {
                "普通截图"
            }
        );

        // 已在截图状态（截图窗口可见）时忽略再次触发，避免重新截屏/重开窗口导致闪屏。
        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
            if w.is_visible().unwrap_or(false) {
                return;
            }
        }

        // 分享可在截图窗口关闭后继续，以便用户把已复制的链接粘贴到聊天工具；
        // 但开始一张新截图时必须主动撤销上一张，避免旧图意外持续暴露。
        app.state::<crate::lan_share::LanShareStore>().stop();

        // 防并发：若上一次截屏尚未结束则丢弃本次
        {
            let mut cap = store.capturing.lock().unwrap();
            if *cap {
                return;
            }
            *cap = true;
        }
        *store.capture_started.lock().unwrap() = Some(triggered);

        // 桌宠独立成窗；截屏前先隐藏，保证它不会落入用户的捕获结果。
        crate::desktop_pet::hide_for_screenshot(&app);

        let capture = match capture_all(store.next_capture_id.fetch_add(1, Ordering::Relaxed)) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("截屏失败: {e}");
                let store = app.state::<ScreenshotStore>();
                *store.capturing.lock().unwrap() = false;
                crate::desktop_pet::restore_after_screenshot(&app);
                return;
            }
        };
        let data = &capture.data;

        tracing::info!(
            "截图捕获（原始像素）: {}ms",
            triggered.elapsed().as_millis()
        );
        let win = match crate::screenshot_window::ensure_window(
            &app,
            Some((data.min_x, data.min_y, data.total_width, data.total_height)),
        ) {
            Ok(window) => window,
            Err(error) => {
                tracing::error!("准备截图窗口失败: {error}");
                store.end_capture();
                crate::desktop_pet::restore_after_screenshot(&app);
                return;
            }
        };

        // 截图窗覆盖整个虚拟桌面，不能用它的左上角判断用户操作的是哪块屏幕。
        // 改按热键触发时的鼠标所在屏幕缩放，让工具栏、面板和放大镜与当前屏幕同密度。
        if let Some(cursor) = data.cursor.as_ref() {
            crate::ui_scale::apply_for_physical_point(&win, &app, cursor.x, cursor.y);
        } else {
            crate::ui_scale::apply(&win);
        }

        // Windows 无边框窗口自带不可见 DWM resize border：set_position 设的是【外框】，
        // 内容(webview/content)会相对外框内缩若干像素（本例左 9px/上 5px），导致内容
        // 盖不到屏幕最左/最上（透过透明窗看到活桌面）。补偿：读「内框-外框」的真实偏移，
        // 把外框往左/上再挪这么多，让内容正好落在虚拟桌面 (min_x, min_y)。
        // 注意：set_size 设的是【内容】尺寸（6400x2160），位置才是问题，只补偿位置即可。
        let border = match (win.outer_position(), win.inner_position()) {
            (Ok(op), Ok(ip)) => (ip.x - op.x, ip.y - op.y),
            _ => (0, 0),
        };
        if border != (0, 0) {
            let _ = win.set_position(PhysicalPosition::new(
                data.min_x - border.0,
                data.min_y - border.1,
            ));
        }

        // 诊断：确认内容实际落点是否等于期望的虚拟桌面包围盒（用于排查跨屏/边缘偏移）
        eprintln!(
            "[screenshot] border offset (inner-outer): ({},{})",
            border.0, border.1
        );
        eprintln!(
            "[screenshot] window expected content: pos=({},{}) size={}x{}",
            data.min_x, data.min_y, data.total_width, data.total_height
        );
        match win.outer_position() {
            Ok(p) => eprintln!("[screenshot] window actual outer pos: ({},{})", p.x, p.y),
            Err(e) => eprintln!("[screenshot] window outer pos read failed: {e}"),
        }
        match win.inner_position() {
            Ok(p) => eprintln!("[screenshot] window actual inner pos: ({},{})", p.x, p.y),
            Err(e) => eprintln!("[screenshot] window inner pos read failed: {e}"),
        }
        match win.inner_size() {
            Ok(s) => eprintln!(
                "[screenshot] window actual inner size: {}x{}",
                s.width, s.height
            ),
            Err(e) => eprintln!("[screenshot] window inner size read failed: {e}"),
        }

        // 注意：这里不再 show()。窗口先隐藏，前端渲染完截图后回传 screenshot_ui_ready 再显示，
        // 以规避 WebView2 冷启动白屏/卡死导致的"始终置顶锁屏"。

        // 通知前端刷新：复用窗口下 main() 不会重跑，由事件触发 loadScreenshot。
        // Keep the original buffers; metadata queries never copy image bytes.
        *store.data.lock().unwrap() = Some(capture);
        if let Err(e) = win.emit("screenshot-refresh", ()) {
            tracing::warn!("emit screenshot-refresh 失败: {e}");
        }

        let store = app.state::<ScreenshotStore>();
        *store.capturing.lock().unwrap() = false;
    });
}

/// 前端把截图渲染完成后的"就绪"回调：此时才真正显示并聚焦截图窗口。
/// 这样能避免 WebView2 冷启动的白色闪屏/卡死窗口被置顶挡住整个屏幕。
#[tauri::command]
pub fn screenshot_ui_ready(app: AppHandle, capture_id: u64) -> bool {
    let store = app.state::<ScreenshotStore>();
    if !store
        .data
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|capture| capture.data.capture_id == capture_id)
    {
        return false;
    }
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        if w.show().is_err() {
            return false;
        }
        let _ = w.set_focus();
        if let Some(started) = store.capture_started.lock().unwrap().take() {
            tracing::info!("截图快捷键到选区显示: {}ms", started.elapsed().as_millis());
        }
        return true;
    }
    false
}

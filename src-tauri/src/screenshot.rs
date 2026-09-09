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
//! - 每次 Alt+S 销毁旧窗口重新 build。首次 WebView2 启动 200-500ms 不可避免，但彻底消除
//!   位置 race 与 stash 缓存带来的 stale-state bug。
//! - 截屏完成 → 写 store → `emit("screenshot-refresh")`，前端监听后清状态 + 重载截图。
//! - `capturing` 互斥锁避免重叠 Alt+S。
//!
//! 坐标约定：
//! - xcap 的 `Monitor::x()/y()/width()/height()` 在 per-monitor DPI aware 进程下是
//!   **虚拟桌面物理像素**（raw PIXELS），与 `Cursor::position()` 同坐标系统。
//! - Tauri 2 builder 的 `.position(x, y)` 是 logical 像素；换算：logical = physical / scale。

use base64::Engine;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Serialize)]
pub struct ScreenData {
    /// 该屏在虚拟桌面中的物理坐标（左上角）
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// 截屏 PNG data URL
    pub data_url: String,
}

/// 每个 monitor 的原始 xcap 元数据（物理像素 + scale factor + primary）。
/// 暴露给前端仅用于 console.info 排查多屏混合 DPI / 跨屏坐标偏移问题，
/// 不参与运行逻辑。运行时零开销（只在 `get_screenshot_data` 里走一次 clone）。
#[derive(Debug, Clone, Serialize)]
pub struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub img_width: u32,
    pub img_height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScreenshotData {
    /// 虚拟桌面包围盒（物理像素）
    pub min_x: i32,
    pub min_y: i32,
    pub total_width: u32,
    pub total_height: u32,
    pub screens: Vec<ScreenData>,
    /// 见 `MonitorInfo` 说明。
    pub monitor_info: Vec<MonitorInfo>,
}

pub struct ScreenshotStore {
    data: Mutex<Option<ScreenshotData>>,
    capturing: Mutex<bool>,
}

impl ScreenshotStore {
    pub fn new() -> Self {
        Self {
            data: Mutex::new(None),
            capturing: Mutex::new(false),
        }
    }
}

/// 截图窗口前端拉取截屏数据
#[tauri::command]
pub fn get_screenshot_data(store: State<'_, ScreenshotStore>) -> Option<ScreenshotData> {
    store.data.lock().unwrap().clone()
}

/// 关闭截图窗口（前端 Esc 时调用）—— 仅隐藏窗口（不销毁），保留供下次复用。
#[tauri::command]
pub fn close_screenshot(app: AppHandle) {
    if let Some(w) = app.get_webview_window("screenshot") {
        // 先让前端清掉画面（移除 body.ready），避免下次 show 时闪旧截图
        let _ = w.emit("screenshot-clear", ());
        let _ = w.hide();
    }
}

/// 复制纯文本到剪贴板（放大镜取色 Ctrl+C 用）
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
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
        use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetClassNameW, GetWindowRect, IsIconic, IsWindowVisible,
        };

        // 桌面 / 任务栏这类"背景窗口"，光标落到它们上面时不应框选（否则绿框会框到整块屏幕）
        const BG_CLASSES: &[&str] = &[
            "Progman", "WorkerW", "SHELLDLL_DefView", "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow",
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
            for label in ["screenshot", "main"] {
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

        let mut ctx = Ctx { x, y, own, found: None };
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
/// Rust 侧只负责「落盘」或「写剪贴板」，然后隐藏截图窗口。
#[derive(Debug, Deserialize)]
pub struct FinishRequest {
    /// "save" | "clipboard"
    pub action: String,
    /// 前端 `canvas.toBlob` 导出的 PNG（base64，可带 data: 前缀）
    pub png: String,
}

#[tauri::command]
pub fn finish_screenshot(app: AppHandle, req: FinishRequest) -> Result<(), String> {
    let b64 = req
        .png
        .trim_start_matches("data:image/png;base64,");
    let png = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;

    match req.action.as_str() {
        "save" => {
            let desktop = dirs::desktop_dir().ok_or("未找到桌面目录")?;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let path = desktop.join(format!("screenshot_{ts}.png"));
            std::fs::write(&path, &png).map_err(|e| e.to_string())?;
            tracing::info!("截图已保存: {}", path.display());
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

    if let Some(w) = app.get_webview_window("screenshot") {
        // 同上：隐藏前清画面，避免下次复用时闪旧截图
        let _ = w.emit("screenshot-clear", ());
        let _ = w.hide();
    }
    Ok(())
}

/// 进入截图模式：截屏 + 复用/创建截图窗口（由全局热键触发）
pub fn start_screenshot(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let store = app.state::<ScreenshotStore>();

        // 已在截图状态（截图窗口可见）时忽略再次触发，避免重新截屏/重开窗口导致闪屏。
        if let Some(w) = app.get_webview_window("screenshot") {
            if w.is_visible().unwrap_or(false) {
                return;
            }
        }

        // 防并发：若上一次截屏尚未结束则丢弃本次
        {
            let mut cap = store.capturing.lock().unwrap();
            if *cap {
                return;
            }
            *cap = true;
        }

        let data = match capture_all() {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("截屏失败: {e}");
                let store = app.state::<ScreenshotStore>();
                *store.capturing.lock().unwrap() = false;
                return;
            }
        };

        // 写 store
        {
            let store = app.state::<ScreenshotStore>();
            *store.data.lock().unwrap() = Some(data.clone());
        }

        // 窗口缓存复用：首次用 builder 创建（一次到位），之后 hide 留存、
        // Alt+S 时 set_position/set_size（物理像素）+ show。
        // 位置 bug 的真正根因是前端 canvas CSS 不拉伸（已修），set_position(PhysicalPosition)
        // 本身行为正常 —— 之前误删缓存导致每次 cold start WebView2 1-3s。
        let win = if let Some(w) = app.get_webview_window("screenshot") {
            let _ = w.set_position(PhysicalPosition::new(data.min_x, data.min_y));
            let _ = w.set_size(PhysicalSize::new(data.total_width, data.total_height));
            w
        } else {
            // 取主屏 scale —— builder 上 position/inner_size 是 logical，
            // wry 内部按窗口所在 monitor 的 scale 反算 physical → SetWindowPos。
            let scale = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| m.scale_factor())
                .unwrap_or(1.0)
                .max(0.5);
            let s = scale as f64;

            match WebviewWindowBuilder::new(
                &app,
                "screenshot",
                WebviewUrl::App("screenshot.html".into()),
            )
            .title("screenshot")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .position(data.min_x as f64 / s, data.min_y as f64 / s)
            .inner_size(data.total_width as f64 / s, data.total_height as f64 / s)
            // 先隐藏创建，等前端把截图渲染好、回传 screenshot_ui_ready 再 show。
            // 避免 WebView2 冷启动偶发白屏/卡死在始终置顶窗口上把用户锁住。
            .visible(false)
            .build()
            {
                Ok(w) => w,
                Err(e) => {
                    tracing::error!("创建截图窗口失败: {e}");
                    let store = app.state::<ScreenshotStore>();
                    *store.capturing.lock().unwrap() = false;
                    return;
                }
            }
        };

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
            Ok(s) => eprintln!("[screenshot] window actual inner size: {}x{}", s.width, s.height),
            Err(e) => eprintln!("[screenshot] window inner size read failed: {e}"),
        }

        // 注意：这里不再 show()。窗口先隐藏，前端渲染完截图后回传 screenshot_ui_ready 再显示，
        // 以规避 WebView2 冷启动白屏/卡死导致的"始终置顶锁屏"。

        // 通知前端刷新：复用窗口下 main() 不会重跑，由事件触发 loadScreenshot。
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
pub fn screenshot_ui_ready(app: AppHandle) {
    if let Some(w) = app.get_webview_window("screenshot") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn capture_all() -> Result<ScreenshotData, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;

    let mut screens = Vec::new();
    let mut monitor_info = Vec::new();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);

    for m in monitors {
        let img = m.capture_image().map_err(|e| e.to_string())?;
        let width = img.width();
        let height = img.height();
        let x = m.x().unwrap_or(0);
        let y = m.y().unwrap_or(0);
        let m_w = m.width().unwrap_or(0);
        let m_h = m.height().unwrap_or(0);
        let scale = m.scale_factor().unwrap_or(1.0);
        let is_primary = m.is_primary().unwrap_or(false);
        if width == 0 || height == 0 {
            continue;
        }

        // PNG 用 Fast 压缩 + NoFilter：默认设置（Best/Adaptive）在 4K 屏上
        // 单张编码要几百 ms，是 Alt+S 延迟的大头之一。
        let mut png = Vec::new();
        PngEncoder::new_with_quality(
            &mut png,
            CompressionType::Fast,
            FilterType::NoFilter,
        )
        .write_image(img.as_raw(), width, height, ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);

        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + width as i32);
        max_y = max_y.max(y + height as i32);

        screens.push(ScreenData {
            x,
            y,
            width,
            height,
            data_url: format!("data:image/png;base64,{b64}"),
        });
        monitor_info.push(MonitorInfo {
            x,
            y,
            width: m_w,
            height: m_h,
            img_width: width,
            img_height: height,
            scale_factor: scale,
            is_primary,
        });
    }

    if screens.is_empty() {
        return Err("未检测到显示器".to_string());
    }

    // 诊断日志：每个 monitor 的原始 xcap 元数据（物理像素、scale factor、image 尺寸）。
    // 多屏/混合 DPI 的坐标问题靠猜是修不掉的（已经返工三轮），输出到 stderr，
    // 让用户截图发回或下一步接 tracing 都方便。release 构建下也能保留。
    eprintln!("[screenshot] monitors (raw, all values physical px):");
    for (i, mi) in monitor_info.iter().enumerate() {
        eprintln!(
            "[screenshot]   [{}] x={} y={} m.w={} m.h={} img={}x{} scale={} primary={}",
            i,
            mi.x,
            mi.y,
            mi.width,
            mi.height,
            mi.img_width,
            mi.img_height,
            mi.scale_factor,
            mi.is_primary
        );
    }
    eprintln!(
        "[screenshot] virtual desktop: minX={} minY={} totalW={} totalH={}",
        min_x,
        min_y,
        max_x - min_x,
        max_y - min_y
    );

    Ok(ScreenshotData {
        min_x,
        min_y,
        total_width: (max_x - min_x).max(1) as u32,
        total_height: (max_y - min_y).max(1) as u32,
        screens,
        monitor_info,
    })
}

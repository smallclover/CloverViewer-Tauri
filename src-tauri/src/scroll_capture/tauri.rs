use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::session::{
    ScrollCaptureProgress, ScrollCaptureRequest, ScrollCaptureResult, SessionHost, SessionOptions,
};
use super::{focus_window, run_manual_session_ext, run_session_ext};

// P1：Tauri 侧（会话状态 + 命令 + 事件）
// ============================================================

/// 当前会话状态（Tauri managed state）
pub struct ScrollCaptureSession {
    inner: Mutex<SessionInner>,
}

struct SessionInner {
    cancel: Arc<AtomicBool>,
    running: bool,
    progress: Option<ScrollCaptureProgress>,
    result: Option<ScrollCaptureResult>,
    /// 前端 HUD 是否与捕获区重叠。重叠时（整屏/整窗选区）每采一帧前都会通知前端
    /// 把 HUD 让开 —— 覆盖窗是透明 WebView，正常情况下不会被 BitBlt 截进去，
    /// 但「整屏选区」这种极端情况下留一个保险，比事后发现长图里烤进一个提示框便宜得多。
    hud_overlap: Arc<AtomicBool>,
}

impl ScrollCaptureSession {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SessionInner {
                cancel: Arc::new(AtomicBool::new(false)),
                running: false,
                progress: None,
                result: None,
                hud_overlap: Arc::new(AtomicBool::new(false)),
            }),
        }
    }

    /// 开始一次会话：已在跑则拒绝（返回 false）
    fn begin(&self) -> Option<(Arc<AtomicBool>, Arc<AtomicBool>)> {
        let mut g = self.inner.lock().unwrap();
        if g.running {
            return None;
        }
        g.running = true;
        g.result = None;
        g.progress = None;
        g.cancel = Arc::new(AtomicBool::new(false));
        g.hud_overlap = Arc::new(AtomicBool::new(false));
        Some((g.cancel.clone(), g.hud_overlap.clone()))
    }

    /// 前端汇报「HUD 是否压在捕获区上」（每次落位后调用）
    fn set_hud_overlap(&self, on: bool) {
        self.inner
            .lock()
            .unwrap()
            .hud_overlap
            .store(on, Ordering::Relaxed);
    }

    fn finish_ok(&self, result: ScrollCaptureResult) {
        let mut g = self.inner.lock().unwrap();
        g.running = false;
        g.result = Some(result);
    }

    fn finish_err(&self, msg: String) {
        let mut g = self.inner.lock().unwrap();
        g.running = false;
        if let Some(p) = g.progress.as_mut() {
            p.stage = "failed".to_string();
            p.message = Some(msg);
            p.input_passthrough = false;
        }
    }

    fn set_progress(&self, p: ScrollCaptureProgress) {
        let mut g = self.inner.lock().unwrap();
        g.progress = Some(p);
    }

    pub fn cancel(&self) {
        let g = self.inner.lock().unwrap();
        g.cancel.store(true, Ordering::Relaxed);
    }

    /// Esc 的反馈必须在工作线程开始最终稳定采样**之前**发出去；否则用户会在
    /// Chrome 平滑滚动或异步重绘期间误以为按键没有生效。
    fn request_finish(&self) -> Option<ScrollCaptureProgress> {
        let mut g = self.inner.lock().unwrap();
        if !g.running {
            return None;
        }
        g.cancel.store(true, Ordering::Relaxed);
        let p = g.progress.as_mut()?;
        p.stage = "finishing".to_string();
        p.message = Some(if p.method.as_deref() == Some("manual") {
            "正在收取最后一帧，请稍候…".to_string()
        } else {
            "正在停止并保留已捕获内容…".to_string()
        });
        Some(p.clone())
    }

    fn take_result(&self) -> Option<ScrollCaptureResult> {
        self.inner.lock().unwrap().result.take()
    }

    fn peek_result(&self) -> bool {
        self.inner.lock().unwrap().result.is_some()
    }

    fn progress(&self) -> Option<ScrollCaptureProgress> {
        self.inner.lock().unwrap().progress.clone()
    }

    fn is_running(&self) -> bool {
        self.inner.lock().unwrap().running
    }
}

impl Default for ScrollCaptureSession {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri 宿主实现：把会话需要的三个副作用落到真实窗口上
struct TauriHost {
    app: tauri::AppHandle,
    escape_registered: std::sync::atomic::AtomicBool,
    capture_exclusion_enabled: std::sync::atomic::AtomicBool,
}

impl TauriHost {
    fn screenshot_window(&self) -> Option<tauri::WebviewWindow> {
        use tauri::Manager;
        self.app.get_webview_window("screenshot")
    }

    /// 滚动结束后把结果 HUD 确实带回最前面。
    ///
    /// 捕获开始时会把目标窗口提到前台；若该窗口本身也是置顶窗口（某些浏览器的
    /// 画中画、远程桌面等），截图覆盖窗虽仍带有 `always_on_top`，却可能在同一
    /// 置顶层级里排到它下面。结果是 HUD 只露出一部分，按钮的点击也会落到目标
    /// 窗口。切换一次置顶状态会把覆盖窗重新排到该层最前，再聚焦以保证按钮可点。
    fn raise_for_result(&self) {
        let Some(window) = self.screenshot_window() else {
            return;
        };

        // 即使最后一次 WheelInput 进度事件晚到，也先恢复原生窗口的命中测试。
        if let Err(e) = window.set_ignore_cursor_events(false) {
            tracing::warn!("滚动截图: 恢复结果 HUD 鼠标命中失败: {e}");
        }

        #[cfg(target_os = "windows")]
        {
            // `set_always_on_top(true)` 在已经置顶时不一定改变 Z 序；先降后升才会
            // 确保覆盖窗压过刚刚成为前台的置顶目标窗口。
            if let Err(e) = window.set_always_on_top(false) {
                tracing::warn!("滚动截图: 降下结果 HUD 层级失败: {e}");
            }
            if let Err(e) = window.set_always_on_top(true) {
                tracing::warn!("滚动截图: 提升结果 HUD 层级失败: {e}");
            }
        }

        if let Err(e) = window.set_focus() {
            tracing::warn!("滚动截图: 聚焦结果 HUD 失败: {e}");
        }
    }

    /// 任务栏进度条：给「正在滚动截图」一个**永远在捕获区之外**的可见指示。
    /// 整窗/全屏选区时覆盖窗内没有任何空地可以放 HUD（放进去就会被截进长图），
    /// 任务栏就成了唯一可靠的反馈通道 —— 像录屏的 REC 红点一样，一眼能看到在跑。
    fn set_taskbar_progress(&self, running: bool, ratio: f32) {
        if let Some(w) = self.screenshot_window() {
            use tauri::window::{ProgressBarState, ProgressBarStatus};
            let state = if running {
                ProgressBarState {
                    status: Some(ProgressBarStatus::Normal),
                    progress: Some((ratio.clamp(0.0, 1.0) * 100.0) as u64),
                }
            } else {
                ProgressBarState {
                    status: Some(ProgressBarStatus::None),
                    progress: None,
                }
            };
            let _ = w.set_progress_bar(state);
        }
    }

    /// `WDA_EXCLUDEFROMCAPTURE` 从 Windows 10 2004（build 19041）才是真正受支持的值；
    /// 更早系统会把它按 WDA_MONITOR 处理，API 仍可能返回成功，却造成错误的捕获结果。
    #[cfg(target_os = "windows")]
    fn supports_capture_exclusion() -> bool {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;

        let build = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
            .and_then(|key| key.get_value::<String, _>("CurrentBuildNumber"))
            .ok()
            .and_then(|value| value.parse::<u32>().ok());
        match build {
            Some(build) if build >= 19041 => true,
            Some(build) => {
                tracing::info!(
                    "滚动截图: Windows build {build} 不支持 WDA_EXCLUDEFROMCAPTURE，改用隐藏 HUD"
                );
                false
            }
            None => {
                // 版本读取失败时宁可走原有兼容路径，也不让旧系统退化成 WDA_MONITOR。
                tracing::warn!("滚动截图: 无法读取 Windows build，改用隐藏 HUD");
                false
            }
        }
    }
}

impl SessionHost for TauriHost {
    fn set_passthrough(&self, on: bool) {
        if let Some(w) = self.screenshot_window() {
            // SendInput 注入要求覆盖窗放行鼠标；否则滚轮事件会被自己的窗吃掉（P0 结论）
            if let Err(e) = w.set_ignore_cursor_events(on) {
                tracing::warn!("set_ignore_cursor_events({on}) 失败: {e}");
            }
        }
    }

    fn focus_target(&self, hwnd: isize) {
        // 目标窗口被第三方窗口遮挡时，屏幕像素捕获会截到遮挡窗口 → 先把它提到前台。
        // 覆盖窗是 always_on_top，所以提前台不会挡住覆盖窗。
        if !focus_window(hwnd) {
            tracing::debug!("SetForegroundWindow 被系统拒绝（继续）");
        }
        // 键盘焦点必须留在覆盖窗上，否则 Esc 停不下来
        if let Some(w) = self.screenshot_window() {
            let _ = w.set_focus();
        }
    }

    fn set_escape_hook(&self, on: bool) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let gs = self.app.global_shortcut();
        if on {
            if self.escape_registered.swap(true, Ordering::Relaxed) {
                return;
            }
            let app = self.app.clone();
            if let Err(e) = gs.on_shortcut("Escape", move |_app, _sc, event| {
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    use tauri::{Emitter, Manager};
                    if let Some(state) = app.try_state::<ScrollCaptureSession>() {
                        // 先同步 HUD，再开始可能长达数秒的稳定采样。
                        if let Some(progress) = state.request_finish() {
                            let _ = app.emit("scroll-capture-progress", progress);
                        }
                    }
                }
            }) {
                tracing::warn!("临时注册全局 Esc 失败: {e}");
                self.escape_registered.store(false, Ordering::Relaxed);
            }
        } else if self.escape_registered.swap(false, Ordering::Relaxed) {
            if let Err(e) = gs.unregister("Escape") {
                tracing::debug!("注销临时全局 Esc 失败: {e}");
            }
        }
    }

    fn set_progress(&self, running: bool, ratio: f32) {
        self.set_taskbar_progress(running, ratio);
    }

    fn prepare_result(&self) {
        self.raise_for_result();
    }

    fn focus_target_for_manual(&self, hwnd: isize) {
        // 手动模式下用户可能用 PageDown / 方向键滚动，焦点必须留在目标窗口。
        if !focus_window(hwnd) {
            tracing::debug!("SetForegroundWindow 被系统拒绝（继续）");
        }
    }

    fn set_capture_exclusion(&self, on: bool) -> bool {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
            };

            if !on
                && !self
                    .capture_exclusion_enabled
                    .swap(false, Ordering::Relaxed)
            {
                return true;
            }
            if on && !Self::supports_capture_exclusion() {
                return false;
            }

            let Some(window) = self.screenshot_window() else {
                tracing::warn!("滚动截图: 找不到覆盖窗，无法设置捕获排除");
                return false;
            };
            let hwnd = match window.hwnd() {
                // Tauri 与本 crate 所用的 windows crate 版本不同；HWND 都是透明
                // 指针包装，像截图窗口拾取逻辑一样在边界处桥接即可。
                Ok(hwnd) => HWND(hwnd.0),
                Err(e) => {
                    tracing::warn!("滚动截图: 读取覆盖窗 HWND 失败，改用隐藏 HUD: {e}");
                    return false;
                }
            };
            let affinity = if on { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
            match unsafe { SetWindowDisplayAffinity(hwnd, affinity) } {
                Ok(()) => {
                    self.capture_exclusion_enabled.store(on, Ordering::Relaxed);
                    tracing::debug!(
                        "滚动截图: 覆盖窗捕获排除{}",
                        if on { "已启用" } else { "已恢复" }
                    );
                    true
                }
                Err(e) => {
                    tracing::warn!(
                        "滚动截图: SetWindowDisplayAffinity({}) 失败: {e}",
                        if on {
                            "WDA_EXCLUDEFROMCAPTURE"
                        } else {
                            "WDA_NONE"
                        }
                    );
                    false
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = on;
            false
        }
    }
}

/// 开始滚动截图（异步跑在工作线程；进度与结果走事件）
#[tauri::command]
pub fn start_scroll_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, ScrollCaptureSession>,
    req: ScrollCaptureRequest,
) -> Result<(), String> {
    let options = SessionOptions::from_request(&req)?;
    let manual_mode = match req.mode.as_deref() {
        None | Some("") | Some("auto") => false,
        Some("manual") => true,
        Some(other) => return Err(format!("未知滚动截图模式: {other}")),
    };
    // 与截图流程共用同一把「正在截图」互斥，避免 Alt+S 在滚动捕获中途插进来
    let store = {
        use tauri::Manager;
        app.try_state::<crate::screenshot::ScreenshotStore>()
    };
    if let Some(store) = store.as_ref() {
        if !store.try_begin_capture() {
            return Err("已有截图/滚动截图在进行中".to_string());
        }
    }
    let cancel = match state.begin() {
        Some(c) => c,
        None => {
            if let Some(store) = store.as_ref() {
                store.end_capture();
            }
            return Err("滚动截图已在进行中".to_string());
        }
    };
    let (cancel, hud_overlap) = cancel;
    // `begin()` 会为新会话重置 AtomicBool，因此不能依赖此前独立命令上报的状态。
    // 将最终判定随启动请求携带，确保第一帧也采用正确的 HUD 策略。
    state.set_hud_overlap(req.hide_hud_during_capture);

    let app2 = app.clone();
    tracing::info!(
        "滚动截图: 开始 {} {}x{} @ ({},{}) 方式={:?}",
        if manual_mode { "手动" } else { "自动" },
        req.w,
        req.h,
        req.x,
        req.y,
        options.method
    );
    std::thread::spawn(move || {
        use tauri::{Emitter, Manager};
        let host = TauriHost {
            app: app2.clone(),
            escape_registered: std::sync::atomic::AtomicBool::new(false),
            capture_exclusion_enabled: std::sync::atomic::AtomicBool::new(false),
        };
        // 工作线程不得因图像处理的意外 panic 而绕过下面的状态清理与 done 事件；否则
        // 截图互斥会永久占用，前端则一直停在“捕获中”。正常错误仍走 Result 原样上报。
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // HUD 重叠或内扩光晕任一存在时，都优先把整个覆盖窗排除在捕获结果外。
            // 若 API 不可用，HUD 沿用整段隐藏，光晕则逐帧隐藏。
            let capture_excluded = (req.hide_hud_during_capture || req.hide_glow_during_capture)
                && host.set_capture_exclusion(true);
            let mut effective_req = req;
            if capture_excluded {
                effective_req.hide_hud_during_capture = false;
                effective_req.hide_glow_during_capture = false;
            }
            let mut emit = |p: ScrollCaptureProgress| {
                if let Some(state) = app2.try_state::<ScrollCaptureSession>() {
                    state.set_progress(p.clone());
                }
                if let Err(e) = app2.emit("scroll-capture-progress", p) {
                    tracing::warn!("emit scroll-capture-progress 失败: {e}");
                }
            };
            let hides_hud = effective_req.hide_hud_during_capture;
            let hides_glow = effective_req.hide_glow_during_capture;
            // 重叠 HUD 整段隐藏；不支持捕获排除时，光晕只在每帧采集前后让开。
            let app3 = app2.clone();
            let on_frame = move |hiding: bool| {
                if let Err(e) = app3.emit(
                    "scroll-capture-hud",
                    serde_json::json!({ "hidden": hiding, "hud": hides_hud, "glow": hides_glow }),
                ) {
                    tracing::warn!("emit scroll-capture-hud 失败: {e}");
                }
            };
            if manual_mode {
                run_manual_session_ext(
                    &effective_req,
                    &options,
                    &host,
                    &cancel,
                    Some(Box::new(on_frame)),
                    &mut emit,
                )
            } else {
                run_session_ext(
                    &effective_req,
                    &options,
                    &host,
                    &cancel,
                    Some(&hud_overlap),
                    Some(Box::new(on_frame)),
                    &mut emit,
                )
            }
        }))
        .unwrap_or_else(|_| {
            tracing::error!("滚动截图工作线程发生未预期异常，已安全结束会话");
            Err("滚动截图内部异常，已安全停止；请重试或改用手动模式".to_string())
        });

        // 收尾：无论如何都要把覆盖窗的 click-through / 全局 Esc / 截图互斥恢复
        host.set_passthrough(false);
        host.set_escape_hook(false);
        let _ = host.set_capture_exclusion(false);
        if let Some(store) = app2.try_state::<crate::screenshot::ScreenshotStore>() {
            store.end_capture();
        }
        // 必须在发出 done 事件前完成。前端收到事件后立即显示「复制/保存/打开」按钮，
        // 此时若覆盖窗仍在目标最大化/置顶窗口后面，用户看到的会是半截且无法点击的 HUD。
        host.raise_for_result();

        match result {
            Ok(res) => {
                tracing::info!(
                    "滚动截图: 完成 {}x{} 帧={} 置信度={} {}",
                    res.width,
                    res.height,
                    res.frames,
                    res.confidence,
                    res.message.clone().unwrap_or_default()
                );
                let payload = serde_json::json!({
                    "ok": true,
                    "width": res.width,
                    "height": res.height,
                    "frames": res.frames,
                    "confidence": res.confidence,
                    "message": res.message,
                });
                if let Some(state) = app2.try_state::<ScrollCaptureSession>() {
                    state.finish_ok(res);
                }
                let _ = app2.emit("scroll-capture-done", payload);
            }
            Err(e) => {
                tracing::warn!("滚动截图: 失败 {e}");
                if let Some(state) = app2.try_state::<ScrollCaptureSession>() {
                    state.finish_err(e.clone());
                }
                let _ = app2.emit(
                    "scroll-capture-done",
                    serde_json::json!({ "ok": false, "message": e }),
                );
            }
        }
    });
    Ok(())
}

/// 停止当前滚动截图（保留已捕获部分）
#[tauri::command]
pub fn stop_scroll_capture(state: tauri::State<'_, ScrollCaptureSession>) {
    state.cancel();
}

/// 拉取当前进度（事件之外的兜底查询）
#[tauri::command]
pub fn scroll_capture_progress(
    state: tauri::State<'_, ScrollCaptureSession>,
) -> Option<ScrollCaptureProgress> {
    state.progress()
}

/// 前端落位后汇报「HUD 是否压在捕获区上」。
///
/// 压在捕获区上时（整屏 / 整窗选区：本屏内没有「选区之外」的空地），
/// HUD 与捕获区重叠时，后端会在会话起止发送 `scroll-capture-hud` 事件。
/// 覆盖窗是透明 WebView、实测不会被 BitBlt 截进去，这是最后一道保险。
#[tauri::command]
pub fn set_scroll_hud_safe(state: tauri::State<'_, ScrollCaptureSession>, overlap: bool) {
    state.set_hud_overlap(overlap);
}

/// 结果落地：action = save / clipboard / open
#[tauri::command]
pub fn finish_scroll_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, ScrollCaptureSession>,
    action: String,
) -> Result<Option<String>, String> {
    let res = state
        .take_result()
        .ok_or_else(|| "没有可保存的滚动截图结果".to_string())?;

    let mut saved_path: Option<String> = None;
    match action.as_str() {
        "save" | "open" => {
            let path = if action == "save" {
                let dir = dirs::desktop_dir().ok_or("未找到桌面目录")?;
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                dir.join(format!("screenshot_long_{ts}.png"))
            } else {
                // 「在查看器中打开」用临时文件，不往桌面丢东西
                let dir = std::env::temp_dir().join("CloverViewer");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                dir.join(format!("longshot_{ts}.png"))
            };
            std::fs::write(&path, &res.png).map_err(|e| format!("写入失败: {e}"))?;
            tracing::info!("滚动截图已保存: {}", path.display());
            saved_path = Some(path.to_string_lossy().to_string());
            if action == "open" {
                use tauri::{Emitter, Manager};
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.unminimize();
                    let _ = main.set_focus();
                }
                let _ = app.emit("open-image", serde_json::json!({ "path": saved_path }));
            }
        }
        "clipboard" => {
            let img = image::load_from_memory_with_format(&res.png, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?
                .to_rgba8();
            let (w, h) = (img.width() as usize, img.height() as usize);
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard
                .set_image(arboard::ImageData {
                    width: w,
                    height: h,
                    bytes: std::borrow::Cow::Owned(img.into_raw()),
                })
                .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("未知动作: {other}")),
    }
    Ok(saved_path)
}

/// 丢弃结果（重截 / 取消时调用）
#[tauri::command]
pub fn discard_scroll_capture(state: tauri::State<'_, ScrollCaptureSession>) {
    let mut g = state.inner.lock().unwrap();
    g.result = None;
    g.progress = None;
}

/// 是否已有可用结果（前端恢复界面状态用）
#[tauri::command]
pub fn has_scroll_capture_result(state: tauri::State<'_, ScrollCaptureSession>) -> bool {
    state.peek_result()
}

/// 会话是否在跑
#[tauri::command]
pub fn scroll_capture_running(state: tauri::State<'_, ScrollCaptureSession>) -> bool {
    state.is_running()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_state_rejects_parallel_runs_and_resets_for_next_run() {
        let session = ScrollCaptureSession::new();
        let (cancel, _) = session.begin().expect("首次启动应成功");
        assert!(session.is_running());
        assert!(session.begin().is_none(), "并行会话必须被拒绝");

        session.cancel();
        assert!(cancel.load(Ordering::Relaxed));
        session.finish_err("expected test failure".to_string());
        assert!(!session.is_running());

        let (next_cancel, _) = session.begin().expect("结束后可开始下一次会话");
        assert!(
            !next_cancel.load(Ordering::Relaxed),
            "新会话必须重置取消状态"
        );
    }
}

// ============================================================

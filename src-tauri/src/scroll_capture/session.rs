use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

use super::{estimate_shift, virtual_screen, window_rect, RectPx, ScrollMethod};

// P1：会话
// ============================================================

/// 一次滚动截图的请求参数（前端 `start_scroll_capture` 的入参）
#[derive(Debug, Clone, Deserialize)]
pub struct ScrollCaptureRequest {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// "auto"（默认）由 CloverViewer 注入滚动；"manual" 则只观察用户自己滚动后的画面。
    #[serde(default)]
    pub mode: Option<String>,
    /// "auto"（默认，探针自动选）或 wheel_post / wheel_post_root / wheel_input / vscroll / pagedown
    #[serde(default)]
    pub method: Option<String>,
    /// 每步滚轮格数；null = 用探针测得的「每格像素」自动校准到约 40% 选区高
    #[serde(default)]
    pub notches: Option<u32>,
    #[serde(default)]
    pub settle_timeout_ms: Option<u64>,
    #[serde(default)]
    pub poll_ms: Option<u64>,
    #[serde(default)]
    pub auto_scroll_top: Option<bool>,
    #[serde(default)]
    pub max_height_px: Option<u32>,
    #[serde(default)]
    pub max_frames: Option<u32>,
    #[serde(default)]
    pub focus_target: Option<bool>,
    /// 前端已判定 HUD 没有可用安全落点；优先将覆盖窗排除在 Windows 捕获结果外，
    /// 排除不可用时才在整个会话中隐藏 HUD。
    #[serde(default)]
    pub hide_hud_during_capture: bool,
    /// 自动滚动的聚焦光晕会伸进捕获区。优先把整个覆盖窗从 Windows 捕获结果排除；
    /// 排除不可用时，每次 BitBlt 前后只短暂隐藏光晕。
    #[serde(default)]
    pub hide_glow_during_capture: bool,
}

impl ScrollCaptureRequest {
    pub fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
        Self {
            x,
            y,
            w,
            h,
            mode: None,
            method: None,
            notches: None,
            settle_timeout_ms: None,
            poll_ms: None,
            auto_scroll_top: None,
            max_height_px: None,
            max_frames: None,
            focus_target: None,
            hide_hud_during_capture: false,
            hide_glow_during_capture: false,
        }
    }

    pub fn rect(&self) -> RectPx {
        RectPx {
            x: self.x,
            y: self.y,
            w: self.w,
            h: self.h,
        }
    }
}

/// 归一化后的会话参数
#[derive(Debug, Clone)]
pub struct SessionOptions {
    pub method: Option<ScrollMethod>,
    pub notches: Option<u32>,
    pub settle_timeout_ms: u64,
    pub poll_ms: u64,
    pub auto_scroll_top: bool,
    pub max_height_px: u32,
    pub max_frames: u32,
    pub focus_target: bool,
}

impl SessionOptions {
    pub fn from_request(req: &ScrollCaptureRequest) -> Result<Self, String> {
        let method = match req.method.as_deref() {
            None | Some("") | Some("auto") => None,
            Some(other) => {
                Some(ScrollMethod::parse(other).ok_or_else(|| format!("未知滚动方式: {other}"))?)
            }
        };
        Ok(Self {
            method,
            notches: req.notches.filter(|n| *n > 0).map(|n| n.min(40)),
            settle_timeout_ms: req.settle_timeout_ms.unwrap_or(2500).clamp(200, 10_000),
            poll_ms: req.poll_ms.unwrap_or(60).clamp(10, 500),
            // 默认**从当前位置**开始往下截（用户框了一块内容，期待的是「从这儿一直往下」）；
            // 「先跳到页面顶部」是另一个意图，交给前端显式传 true。
            auto_scroll_top: req.auto_scroll_top.unwrap_or(false),
            max_height_px: req.max_height_px.unwrap_or(20_000).clamp(200, 200_000),
            max_frames: req.max_frames.unwrap_or(200).clamp(2, 2000),
            focus_target: req.focus_target.unwrap_or(true),
        })
    }
}

/// 进度事件负载（`scroll-capture-progress`）
#[derive(Debug, Clone, Serialize)]
pub struct ScrollCaptureProgress {
    /// probing | capturing | finishing | matched | low_confidence | done | partial | failed | cancelled
    pub stage: String,
    pub frames: u32,
    pub width: u32,
    pub height: u32,
    pub method: Option<String>,
    pub message: Option<String>,
    /// true = 覆盖窗已临时 click-through（SendInput 注入需要），此时 HUD 的按钮点不到，
    /// 前端应提示「按 Esc 停止」
    pub input_passthrough: bool,
    /// 累积长图的缩略预览（data URL，宽 ≤ PREVIEW_WIDTH）
    pub preview: Option<String>,
    /// **实际捕获区**（虚拟桌面物理像素 x,y,w,h）。
    ///
    /// 前端必须按这个矩形去「挖空」覆盖窗，而不是按用户选区：矮选区会被自动向下补足
    /// （见 `pad_capture_rect`），补出来的那部分如果没挖空，截到的就是我们自己的压暗遮罩 ——
    /// 现象是长图「上方亮、下方暗、交界一条绿边」（用户实测报回）。
    pub capture: Option<[i32; 4]>,
}

impl ScrollCaptureProgress {
    pub(super) fn bare(stage: &str, rect: &RectPx) -> Self {
        Self {
            stage: stage.to_string(),
            frames: 0,
            width: rect.w,
            height: 0,
            method: None,
            message: None,
            input_passthrough: false,
            preview: None,
            capture: None,
        }
    }

    /// 带上「实际捕获区」（前端据此挖空覆盖窗）
    pub(super) fn with_capture(mut self, cap: &RectPx) -> Self {
        self.capture = Some([cap.x, cap.y, cap.w as i32, cap.h as i32]);
        self
    }
}

/// 会话结果（图片本体留在 Rust，前端只拿尺寸/帧数，按需 save/copy/open）
#[derive(Debug)]
pub struct ScrollCaptureResult {
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    /// high | low | partial
    pub confidence: String,
    pub message: Option<String>,
    pub png: Vec<u8>,
}

/// 会话需要的「宿主能力」：探针二进制用 `NoHost`，Tauri 侧用真实实现。
/// 这样 `run_session` 本身不依赖 Tauri，可以在命令行里端到端复跑（P1 验证手段）。
pub trait SessionHost {
    /// 覆盖窗是否 click-through（SendInput 注入必须，否则滚轮被自己的窗吃掉）
    fn set_passthrough(&self, on: bool);
    /// 把目标窗口带到前台，并把键盘焦点交还覆盖窗（保证 Esc 可用）
    fn focus_target(&self, hwnd: isize);
    /// 手动模式需要把键盘焦点真正交给目标窗口，不能再切回截图覆盖窗。
    fn focus_target_for_manual(&self, hwnd: isize) {
        self.focus_target(hwnd);
    }
    /// 注册/注销临时全局 Esc（click-through 时 HUD 按钮点不到，这是安全出口）
    fn set_escape_hook(&self, on: bool);
    /// 捕获期间的任务栏进度指示（覆盖窗里没空地放 HUD 时的唯一可见反馈）。
    /// 默认空实现，命令行探针不需要。
    fn set_progress(&self, _running: bool, _ratio: f32) {}
    /// 尝试把覆盖窗从 Windows 的捕获结果中排除。
    ///
    /// 返回 `true` 代表已成功启用；调用方可因此保持 HUD 可见。默认 `false`，
    /// 让非 Windows 宿主及探针自然退回到隐藏 HUD 的兼容路径。
    fn set_capture_exclusion(&self, _on: bool) -> bool {
        false
    }
}

/// 无需宿主能力的空实现（命令行/单测用）
pub struct NoHost;
impl SessionHost for NoHost {
    fn set_passthrough(&self, _on: bool) {}
    fn focus_target(&self, _hwnd: isize) {}
    fn set_escape_hook(&self, _on: bool) {}
}

/// 容差路径的额外门槛：绝对误差也不能太大（否则是「画面全变了」而不是「亚像素重绘」）
pub(super) fn est_err_ok(prev: &RgbaImage, cur: &RgbaImage) -> bool {
    estimate_shift(prev, cur)
        .map(|e| e.err < 12.0)
        .unwrap_or(false)
}

/// 给「太矮」的选区补一块更高的捕获区（**同宽、向下扩展**）。
///
/// ⚠ 目前**不使用**：上层的「选区高度下限 400px」已经挡掉了所有太矮的情况。
/// 保留实现是因为将来若要支持「自动向上/向下扩展选区」会用到它；启用前请先解决它带来的
/// 两个副作用：① 补出来的区域必须保持透明（否则遮罩被截进长图）→ 界面上会出现一条亮带；
/// ② 用户选区的边框线会落进捕获区 → 被截进长图（绿线）。
#[allow(dead_code)]
fn pad_capture_rect(rect: &RectPx, target_root: isize, need_h: u32) -> (RectPx, bool) {
    if rect.h >= need_h {
        return (*rect, false);
    }
    let (_vx, _vy, _vw, vh) = virtual_screen();
    // 向下扩展的上限：屏幕底边 与 目标窗口底边 取小（否则会把窗口外的桌面/别的窗口截进来）
    let mut bottom_limit = rect.y.saturating_add(vh);
    if let Some(wr) = window_rect(target_root) {
        if wr.h > 0 {
            bottom_limit = bottom_limit.min(wr.bottom());
        }
    }
    let max_h = (bottom_limit - rect.y).max(0) as u32;
    let h = need_h.min(max_h);
    if h <= rect.h {
        return (*rect, false);
    }
    (
        RectPx {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h,
        },
        true,
    )
}

/// 用一次注入把光标「放进选区 → 注入 → 移出选区」。
///
/// 移出是必须的：光标停在内容上会触发悬停高亮，而高亮出现在**每一帧的同一位置**，
/// 会被拼接算法当成固定元素（P0 结论）。
pub(super) fn with_cursor_at<F>(rect: &RectPx, method: ScrollMethod, f: F) -> Result<String, String>
where
    F: FnOnce() -> Result<String, String>,
{
    let mut saved = POINT { x: 0, y: 0 };
    let has_saved = unsafe { GetCursorPos(&mut saved).is_ok() };
    let out = f();
    if matches!(method, ScrollMethod::WheelInput) {
        // 注入本身已把光标放到选区中心；这里负责挪出选区
        let (px, py) = park_point(rect);
        unsafe {
            let _ = SetCursorPos(px, py);
        }
    }
    if has_saved {
        // 不恢复原位置：整个会话期间光标都停在选区外，避免高亮污染（结束时统一恢复）
        let _ = saved;
    }
    out
}

/// 选区外侧、仍在虚拟桌面内的一个「停车点」（给光标用，避免悬停高亮污染帧）
pub fn park_point(rect: &RectPx) -> (i32, i32) {
    let (vx, vy, vw, vh) = virtual_screen();
    let cands = [
        (rect.x - 6, rect.y - 6),
        (rect.right() + 6, rect.y - 6),
        (rect.x - 6, rect.bottom() + 6),
        (rect.right() + 6, rect.bottom() + 6),
        (vx + 2, rect.y.min(vy + vh - 2)),
    ];
    for (x, y) in cands {
        if x >= vx && y >= vy && x < vx + vw && y < vy + vh {
            return (x, y);
        }
    }
    (vx + 2, vy + 2)
}

/// 采帧期间「宿主让开」的开关。
///
/// 会话在每次抓帧前打开、抓完关闭；宿主（Tauri 侧）注册的回调据此隐藏自己的 UI。
/// `settle_capture_ext` 只读这个开关（不接触回调），于是回调的借用不会跨调用存活。
pub struct FrameHideGate {
    cb: Option<Box<dyn FnMut(bool) + Send>>,
    /// 采帧中（true = 宿主应隐藏 UI）
    hiding: bool,
    /// 宿主当前是否处于「已隐藏」态（Drop 时兜底恢复）
    hidden: bool,
    /// 是否启用（HUD 重叠或内扩光晕需要采帧让开时才触发）
    enabled: bool,
    /// 重叠时，HUD 从首帧前隐藏到整个会话结束。恢复只发生一次，避免逐帧闪烁。
    keep_hidden: bool,
}

impl FrameHideGate {
    pub fn new(cb: Option<Box<dyn FnMut(bool) + Send>>) -> Self {
        Self {
            cb,
            hiding: false,
            hidden: false,
            enabled: false,
            keep_hidden: false,
        }
    }

    pub fn set_keep_hidden(&mut self, on: bool) {
        self.enabled = on;
        self.keep_hidden = on;
    }

    /// 光晕只需逐帧让开：不沿用 HUD 的整段隐藏策略。
    pub fn set_hide_each_frame(&mut self, on: bool) {
        self.enabled |= on;
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn hiding(&self) -> bool {
        self.enabled && self.hiding
    }

    /// 抓帧开始：通知宿主隐藏 UI，并等一小段让合成器真正把它从画面上撤掉
    /// （覆盖窗是透明 WebView，正常情况下 BitBlt 根本抓不到它；这里只为「整屏选区」
    /// 这种 HUD 只能压在捕获区上的极端情况兜底，代价是每帧多 ~120ms）。
    pub fn begin_frame(&mut self) {
        if !self.enabled || self.hiding {
            return;
        }
        self.hiding = true;
        if !self.hidden {
            if let Some(cb) = self.cb.as_mut() {
                cb(true);
            }
            self.hidden = true;
            // HUD 会话隐藏沿用保守等待；只有光晕时等两个合成帧，兼顾干净捕获和滚动速度。
            std::thread::sleep(Duration::from_millis(if self.keep_hidden {
                120
            } else {
                40
            }));
        }
    }

    /// 抓帧结束：普通模式会恢复宿主 UI；重叠模式保持隐藏，直到会话收尾。
    pub fn end_frame(&mut self) {
        if !self.hiding {
            return;
        }
        self.hiding = false;
        if self.hidden && !self.keep_hidden {
            if let Some(cb) = self.cb.as_mut() {
                cb(false);
            }
            self.hidden = false;
        }
    }

    /// 会话结束：无论怎么收尾都要把 UI 恢复（错误路径也不会留下一个永远隐藏的 HUD）
    pub fn restore(&mut self) {
        self.hiding = false;
        if self.hidden {
            if let Some(cb) = self.cb.as_mut() {
                cb(false);
            }
            self.hidden = false;
        }
    }
}

/// 会话期间的「宿主租约」：持有它就能保证**无论怎么退出**（正常结束、`?` 提前返回、
/// 显式 `return Err`、乃至 panic）都把宿主状态还原。
///
/// 为什么必须是 `Drop` 而不是「在函数末尾手动收尾」：`run_session_ext` 里有很多 `?`
/// （每次 `settle_capture`、`append_band`、`encode_png`…），手动收尾的写法每多一个
/// 提前返回就多一条泄漏路径。历史上就踩过：`settle_capture` 出错时直接 `?` 返回，
/// 于是覆盖窗**永久停在 click-through**（后续用户点 HUD、点关闭都点不到），
/// 而且临时注册的全局 Esc 也没注销 —— 现象是「用 Esc 关掉之后，整个应用像死了一样」。
pub(super) struct SessionCleanup<'a> {
    pub(super) host: &'a dyn SessionHost,
    /// 采帧期间的 HUD 让位开关（随租约一起兜底还原）
    pub(super) gate: Rc<RefCell<FrameHideGate>>,
}

impl Drop for SessionCleanup<'_> {
    fn drop(&mut self) {
        self.host.set_escape_hook(false);
        self.host.set_passthrough(false);
        self.host.set_progress(false, 0.0);
        self.gate.borrow_mut().restore();
    }
}

/// 逐帧诊断日志（**仅在设置了 `CLOVER_SCROLL_DEBUG` 时启用**）。
///
/// 为什么要有它：滚动拼接的失败原因都在「每帧的位移/重叠/追加决策」这些数字里，
/// 而 `tauri dev` 的 console 输出用户未必能贴回来。开启后（`$env:CLOVER_SCROLL_DEBUG=1`）
/// 会把每帧的 diff / 匹配结果 / 追加高度 / 画布高度写到临时目录的
/// `clover_scroll_debug.log`，出问题时直接把这个文件发回来即可。生产运行零开销。
pub(super) struct SessionLog {
    file: Option<std::fs::File>,
}

impl SessionLog {
    pub(super) fn open(tag: &str) -> Self {
        let on = std::env::var("CLOVER_SCROLL_DEBUG")
            .map(|v| v != "0" && !v.is_empty())
            .unwrap_or(false);
        if !on {
            return Self { file: None };
        }
        let path = std::env::temp_dir().join("clover_scroll_debug.log");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        let mut log = Self { file };
        log.log(&format!(
            "==== {tag} {} pid={} ====",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            std::process::id()
        ));
        log.log(&format!("log file: {}", path.display()));
        log
    }

    pub(super) fn log(&mut self, msg: &str) {
        use std::io::Write;
        let Some(f) = self.file.as_mut() else { return };
        let _ = writeln!(f, "{msg}");
        let _ = f.flush();
    }
}

/// 会话期间把光标钉在选区外，结束后还原（避免悬停高亮污染帧 + 不打扰用户）
pub(super) struct CursorGuard {
    pub(super) had: bool,
    pub(super) pos: POINT,
}

impl Drop for CursorGuard {
    fn drop(&mut self) {
        if self.had {
            unsafe {
                let _ = SetCursorPos(self.pos.x, self.pos.y);
            }
        }
    }
}

pub(super) const PREVIEW_WIDTH: u32 = 120;
pub(super) const PREVIEW_MAX_H: u32 = 360;
pub(super) const MAX_CANVAS_BYTES: u64 = 768 * 1024 * 1024;

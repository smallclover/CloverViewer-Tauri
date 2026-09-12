//! 滚动截图（长截图）。
//!
//! 本模块是 [`SCROLL_CAPTURE_PLAN.md`](../../SCROLL_CAPTURE_PLAN.md) 的落地代码：
//! - **P0 原语**（第 4 节）：区域 BitBlt 捕获、目标窗口解析、四种滚动注入、稳定帧等待；
//! - **P1 会话**（第 5 节）：探针自动降级、逐帧比对拼接、进度事件、结果落地。
//!
//! 坐标约定（与 `screenshot.rs` 一致）：**全部物理像素，虚拟桌面坐标系**。
//! 进程必须是 per-monitor DPI aware —— Tauri 主程序由 manifest 保证，独立探针
//! 二进制需要显式调用 [`ensure_dpi_aware`]（否则坐标会被 DPI 虚拟化，全盘错位）。
//!
//! 与 `screenshot.rs` 的关系：那边是「截一整屏 → PNG → 前端拼」，是**一次性**流程；
//! 这边是「截一小块 → RGBA 内存 → 逐帧比对」，是**高频循环**流程，所以刻意不复用
//! PNG/base64 路径（4K 屏单帧编码几百 ms，滚动 20 帧就废了）。
//!
//! P0 实测结论（详见方案附录 A）直接决定了这里的设计：
//! 1. 没有任何单一注入方式通吃所有应用 → 必须先探针再降级；
//! 2. Chrome 平滑滚动要 ≈1.1s 才停 → 必须稳定帧等待，不能用固定延迟；
//! 3. `WM_VSCROLL`/`PageDown` 必须发给最深子窗口（发顶层无效）；
//! 4. 周期性内容会让朴素位移估计失效 → 拼接用行指纹匹配 + 位移一致性先验；
//! 5. 光标停在选区内会留下悬停高亮污染帧 → SendInput 路径发完滚轮立刻把光标移出选区。
#![allow(dead_code)] // 部分工具函数只在探针二进制里用到

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, RgbaImage};
use serde::{Deserialize, Serialize};

/// 一格滚轮的 delta（`WHEEL_DELTA`，windows crate 里没有该常量，硬编码）
pub const WHEEL_DELTA: u32 = 120;

/// 稳定帧判定阈值：差异像素占比低于此值即认为「画面已稳定」
const STABLE_DIFF_RATIO: f32 = 0.001;
/// 连续多少次「稳定」轮询才认为真的稳定了。
///
/// 必须是多次：Chrome 的平滑滚动是缓出曲线，**收尾阶段每 80ms 只挪一两个像素**，
/// 连续两次采样很容易低于阈值 → 早期实现（2 次）会在动画还没停时就截帧，
/// 拿到的是「滚到一半」的画面，拼接必然错位（P1 端到端实测：标定值被算成 193px/格，
/// 而真实值约 125px/格，就是这个假稳定害的）。
const STABLE_POLLS: u32 = 3;
/// 帧比较的通道容差（吸收极少量非确定性渲染差异，如字体次像素渲染抖动）
const DIFF_TOLERANCE: i16 = 2;
/// 「这一帧和上一帧一样」的阈值（比稳定阈值更严：真的到底了才会连续几帧完全一致）
const SAME_FRAME_RATIO: f32 = 0.0005;
/// 探针判定「确实滚动了」的像素差异阈值。
/// 取 0.002 是因为：周期性内容滚动后的 diff 只有 3-8‰（真的滚了），
/// 而光标悬停高亮造成的干扰 diff 约 1‰（没滚）——两者恰好能分开（P0 实测）。
const SCROLLED_DIFF_RATIO: f32 = 0.002;
/// 位移小于此值视为「没动」（到底）
const MIN_SHIFT: u32 = 4;
/// 连续匹配失败多少次就放弃（保留已拼接部分）
const MAX_MATCH_FAILURES: u32 = 3;


// ============================================================
// 通用数据类型（平台无关）
// ============================================================

/// 物理像素矩形（虚拟桌面坐标，左上角 + 宽高）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RectPx {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl RectPx {
    pub fn right(&self) -> i32 {
        self.x + self.w as i32
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h as i32
    }
    pub fn area(&self) -> i64 {
        self.w as i64 * self.h as i64
    }
    /// 中心点（滚动注入的落点）
    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w as i32 / 2, self.y + self.h as i32 / 2)
    }
    /// 四周内缩（用于避开窗口边框 / 滚动条 / 圆角）
    pub fn inset(&self, px: i32) -> RectPx {
        let w = (self.w as i32 - px * 2).max(1) as u32;
        let h = (self.h as i32 - px * 2).max(1) as u32;
        RectPx {
            x: self.x + px,
            y: self.y + px,
            w,
            h,
        }
    }
}

/// 滚动注入方式（P0 逐一验证兼容性，P1 会按验证结果自动降级）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollMethod {
    /// `PostMessage(WM_MOUSEWHEEL)` 发给光标下**最深层子窗口**（默认首选：不依赖焦点）
    WheelPost,
    /// `PostMessage(WM_MOUSEWHEEL)` 发给**顶层窗口**（对照用，看应用是否依赖子窗口路由）
    WheelPostRoot,
    /// `SendInput(MOUSEEVENTF_WHEEL)` 模拟真实滚轮（兼容性最好，但需要覆盖窗 click-through）
    WheelInput,
    /// `PostMessage(WM_VSCROLL, SB_LINEDOWN)`（标准滚动条控件专杀）
    VScroll,
    /// `PostMessage(WM_KEYDOWN, VK_NEXT)`（PageDown，网页/文档兜底）
    PageDown,
}

impl ScrollMethod {
    pub const ALL: [ScrollMethod; 5] = [
        ScrollMethod::WheelPost,
        ScrollMethod::WheelPostRoot,
        ScrollMethod::WheelInput,
        ScrollMethod::VScroll,
        ScrollMethod::PageDown,
    ];

    pub fn name(&self) -> &'static str {
        match self {
            ScrollMethod::WheelPost => "wheel_post",
            ScrollMethod::WheelPostRoot => "wheel_post_root",
            ScrollMethod::WheelInput => "wheel_input",
            ScrollMethod::VScroll => "vscroll",
            ScrollMethod::PageDown => "pagedown",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim().to_ascii_lowercase();
        Self::ALL.into_iter().find(|m| m.name() == s).or(match s.as_str() {
            // 便利别名
            "post" => Some(ScrollMethod::WheelPost),
            "input" => Some(ScrollMethod::WheelInput),
            "all" => Some(ScrollMethod::WheelPost),
            _ => None,
        })
    }
}

/// 顶层窗口信息（探针用来定位目标窗口 / 打印诊断）
#[derive(Debug, Clone)]
pub struct WinInfo {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    pub class: String,
    /// 窗口外框（物理像素）
    pub rect: RectPx,
    /// 客户区（物理像素）
    pub client: RectPx,
    pub is_own: bool,
}

impl WinInfo {
    pub fn hwnd_str(&self) -> String {
        format!("0x{:X}", self.hwnd)
    }
}

/// `GetScrollInfo(SB_VERT)` 的结果（有标准滚动条的窗口才能拿到）
#[derive(Debug, Clone, Copy)]
pub struct ScrollState {
    pub min: i32,
    pub max: i32,
    pub pos: i32,
    pub page: i32,
    pub track_pos: i32,
}

impl ScrollState {
    /// 是否已到底（ShareX 的判据）
    pub fn at_bottom(&self) -> bool {
        self.page > 0 && self.track_pos + self.page - 1 >= self.max
    }
}

/// 稳定帧等待的结果
#[derive(Debug)]
pub struct SettleResult {
    pub image: RgbaImage,
    /// 从开始等待到判定稳定（或超时）的耗时
    pub elapsed_ms: u128,
    /// 轮询次数
    pub polls: u32,
    /// true = 等到超时仍未稳定（页面一直在动，如动画/视频）
    pub timed_out: bool,
}

/// 两帧之间的纵向位移估计
#[derive(Debug, Clone, Copy)]
pub struct ShiftEstimate {
    /// 估计位移（像素，正数 = 内容向上移动了这么多，即向下滚了多少）
    pub shift: u32,
    /// 该位移下的平均灰度误差（越小越可信）
    pub err: f32,
    /// 位移 0（即没滚动）时的平均灰度误差，用作对照
    pub err_at_zero: f32,
}

impl ShiftEstimate {
    /// 误差相对「没滚动」的改善倍数；远大于 1 才说明确实滚动了
    pub fn improvement(&self) -> f32 {
        if self.err <= f32::EPSILON {
            f32::INFINITY
        } else {
            self.err_at_zero / self.err
        }
    }
}

// ============================================================
// Win32 实现
// ============================================================

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetDIBits, GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_MOUSE, MAPVK_VK_TO_VSC, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    VK_NEXT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, EnumWindows, GetAncestor, GetClassNameW, GetClientRect, GetCursorPos,
    GetDesktopWindow, GetForegroundWindow, GetScrollInfo, GetSystemMetrics, GetWindowRect,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW, SetCursorPos,
    SetForegroundWindow, ShowWindow, WindowFromPoint, CWP_SKIPINVISIBLE, GA_ROOT, SB_LINEDOWN,
    SB_VERT, SCROLLINFO, SIF_ALL, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, SW_MAXIMIZE, SW_RESTORE, WM_KEYDOWN, WM_KEYUP, WM_MOUSEWHEEL, WM_VSCROLL,
};

/// 把裸指针封装的 HWND 在跨函数传递时用 isize 表示（HWND 不是 Send）。
fn hwnd_from(raw: isize) -> HWND {
    HWND(raw as *mut core::ffi::c_void)
}

/// 独立二进制必须显式声明 DPI 感知；Tauri 主程序由 manifest 声明，重复调用无副作用。
/// 必须在任何窗口/坐标相关调用之前执行。
pub fn ensure_dpi_aware() {
    unsafe {
        // 已设置过会返回错误，忽略即可（例如 Tauri 主程序里 manifest 已生效）
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

/// `MAKELPARAM(x, y)`：低 16 位 x、高 16 位 y
fn make_lparam(x: i32, y: i32) -> isize {
    (((y as u16 as u32) << 16) | (x as u16 as u32)) as isize
}

// ---------- 区域捕获 ----------

/// 捕获虚拟桌面上的一个矩形区域（物理像素）。
///
/// 走 `GetWindowDC(桌面) + BitBlt`，与 `xcap` 的 monitor 捕获同源；不编码 PNG，
/// 直接返回 RGBA（alpha 统一填 255，BitBlt 出来的 alpha 是 0，不填会被 PNG 编码成全透明）。
pub fn capture_rect(rect: &RectPx) -> Result<RgbaImage, String> {
    if rect.w == 0 || rect.h == 0 {
        return Err("捕获区域宽高为 0".to_string());
    }
    unsafe {
        let desktop = GetDesktopWindow();
        let src = GetWindowDC(Some(desktop));
        if src.is_invalid() {
            return Err("GetWindowDC(桌面) 失败".to_string());
        }
        let mem = CreateCompatibleDC(Some(src));
        if mem.is_invalid() {
            let _ = ReleaseDC(Some(desktop), src);
            return Err("CreateCompatibleDC 失败".to_string());
        }
        let bmp = CreateCompatibleBitmap(src, rect.w as i32, rect.h as i32);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem);
            let _ = ReleaseDC(Some(desktop), src);
            return Err("CreateCompatibleBitmap 失败".to_string());
        }
        let old = SelectObject(mem, bmp.into());
        let blt = BitBlt(
            mem,
            0,
            0,
            rect.w as i32,
            rect.h as i32,
            Some(src),
            rect.x,
            rect.y,
            SRCCOPY,
        );

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = rect.w as i32;
        // 负高度 = 自上而下，省掉一次行翻转
        info.bmiHeader.biHeight = -(rect.h as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;

        let mut buf = vec![0u8; rect.w as usize * rect.h as usize * 4];
        let lines = GetDIBits(
            mem,
            bmp,
            0,
            rect.h,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            &mut info,
            DIB_RGB_COLORS,
        );

        // 清理顺序：恢复旧 GDI 对象 → 删位图 → 删内存 DC → 释放窗口 DC
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        let _ = ReleaseDC(Some(desktop), src);

        blt.map_err(|e| format!("BitBlt 失败: {e}"))?;
        if lines == 0 {
            return Err("GetDIBits 失败".to_string());
        }

        // BGRA → RGBA，并把 alpha 补成不透明
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        RgbaImage::from_raw(rect.w, rect.h, buf).ok_or_else(|| "RgbaImage::from_raw 失败".to_string())
    }
}

// ---------- 帧比较 / 稳定等待 ----------

/// 两帧的差异像素占比（隔行隔列采样，只用于「是否稳定」的判定）
pub fn frame_diff_ratio(a: &RgbaImage, b: &RgbaImage) -> f32 {
    if a.dimensions() != b.dimensions() {
        return 1.0;
    }
    let (w, h) = a.dimensions();
    let (pa, pb) = (a.as_raw(), b.as_raw());
    let mut diff = 0u32;
    let mut total = 0u32;
    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            let i = ((y * w + x) * 4) as usize;
            let d = (pa[i] as i16 - pb[i] as i16).abs()
                | (pa[i + 1] as i16 - pb[i + 1] as i16).abs()
                | (pa[i + 2] as i16 - pb[i + 2] as i16).abs();
            if d > DIFF_TOLERANCE {
                diff += 1;
            }
            total += 1;
            x += 2;
        }
        y += 2;
    }
    if total == 0 {
        0.0
    } else {
        diff as f32 / total as f32
    }
}

/// 等待画面稳定后返回一帧。
///
/// 比 ShareX 的固定 `ScrollDelay` 稳：慢渲染页面 / 懒加载列表在固定延迟下会截到
/// 「滚了一半」的中间态，这里改成「连续 [`STABLE_POLLS`] 次捕获一致才认为稳定」
/// （不能只比两次：Chrome 的平滑滚动收尾阶段每次只挪一两个像素，两次就够骗过阈值了）。
pub fn settle_capture(rect: &RectPx, timeout_ms: u64, poll_ms: u64) -> Result<SettleResult, String> {
    settle_capture_ext(rect, timeout_ms, poll_ms, None)
}

/// `settle_capture` 的扩展版：每一次底层 `capture_rect` 前后回调一次
/// `on_capture(hiding)`——`true` = 即将抓帧（宿主可让开自己的 UI），`false` = 抓完。
pub fn settle_capture_ext(
    rect: &RectPx,
    timeout_ms: u64,
    poll_ms: u64,
    mut on_capture: Option<&mut dyn FnMut(bool)>,
) -> Result<SettleResult, String> {
    let mut grab = |r: &RectPx| -> Result<RgbaImage, String> {
        if let Some(cb) = on_capture.as_deref_mut() {
            cb(true);
        }
        let img = capture_rect(r);
        if let Some(cb) = on_capture.as_deref_mut() {
            cb(false);
        }
        img
    };
    let start = Instant::now();
    let poll = Duration::from_millis(poll_ms.max(10));
    let mut last = grab(rect)?;
    let mut polls = 0u32;
    let mut stable_streak = 0u32;

    loop {
        std::thread::sleep(poll);
        let cur = grab(rect)?;
        polls += 1;
        if frame_diff_ratio(&last, &cur) <= STABLE_DIFF_RATIO {
            stable_streak += 1;
            if stable_streak >= STABLE_POLLS {
                return Ok(SettleResult {
                    image: cur,
                    elapsed_ms: start.elapsed().as_millis(),
                    polls,
                    timed_out: false,
                });
            }
        } else {
            stable_streak = 0;
        }
        if start.elapsed().as_millis() >= timeout_ms as u128 {
            return Ok(SettleResult {
                image: cur,
                elapsed_ms: start.elapsed().as_millis(),
                polls,
                timed_out: true,
            });
        }
        last = cur;
    }
}

// ---------- 纵向位移估计（P0 的粗糙版，P1 会被行指纹匹配取代） ----------

/// 灰度降采样：宽固定 `target_w`，每个输出列取该块内几个采样的**平均值**。
///
/// 必须是块平均而不是取块中心单点：亚像素滚动/整屏重绘的目标（典型是 WinForms ListBox，
/// 它的行高是 18.33px 这种小数）会让同一内容在不同滚动位置**重新渲染**，逐点比较必然有
/// 边缘差异。块平均把这些差异平均掉，SAD 才能看出真正的对齐位置（P1 实测：
/// 取单点时 ListBox 的 SAD 在真位移 55px 与 0 之间几乎分不开，块平均后是 0.66 vs 0.90）。
fn gray_downsample(img: &RgbaImage, target_w: u32) -> (Vec<u8>, u32, u32) {
    let (w, h) = img.dimensions();
    let step_x = (w / target_w.max(1)).max(1);
    let out_w = (w / step_x).max(1);
    let out_h = h;
    let raw = img.as_raw();
    // 每列最多取 4 个采样求平均
    let taps = step_x.min(4).max(1);
    let tap_step = (step_x / taps).max(1);
    let mut out = Vec::with_capacity((out_w * out_h) as usize);
    for y in 0..out_h {
        let base = y as usize * w as usize * 4;
        for ox in 0..out_w {
            let x_start = ox * step_x;
            let mut sum = 0u32;
            let mut n = 0u32;
            let mut t = 0;
            while t < taps {
                let x = (x_start + t * tap_step).min(w - 1);
                let i = base + x as usize * 4;
                sum += (299 * raw[i] as u32 + 587 * raw[i + 1] as u32 + 114 * raw[i + 2] as u32) / 1000;
                n += 1;
                t += 1;
            }
            out.push(if n == 0 { 0 } else { (sum / n) as u8 });
        }
    }
    (out, out_w, out_h)
}

/// 容差版位移测量：见下方 `tolerant_shift`（定义在 SAD 核心旁）。

/// SAD 核心：在给定的灰度行图上找最佳位移
fn shift_from_grays(gp: &[u8], gc: &[u8], gw: usize, h: u32) -> Option<ShiftEstimate> {
    if gw == 0 || h < 32 {
        return None;
    }
    // 左右各忽略 5% 列（躲滚动条/边框）
    let margin = (gw / 20).max(1);
    let x0 = margin;
    let x1 = gw.saturating_sub(margin).max(x0 + 1);

    let hh = h as usize;
    let max_shift = (hh / 2).max(1);
    let rows: Vec<usize> = (0..hh).step_by(2).collect();

    let score = |shift: usize| -> f32 {
        let mut sum = 0u64;
        let mut n = 0u64;
        for &y in &rows {
            let py = y + shift;
            if py >= hh {
                break;
            }
            let a = &gc[y * gw + x0..y * gw + x1];
            let b = &gp[py * gw + x0..py * gw + x1];
            for (x, av) in a.iter().enumerate() {
                sum += (*av as i32 - b[x] as i32).unsigned_abs() as u64;
                n += 1;
            }
        }
        if n == 0 {
            f32::MAX
        } else {
            sum as f32 / n as f32
        }
    };

    let err_at_zero = score(0);
    let mut best = (0usize, err_at_zero);
    for shift in 1..=max_shift {
        let e = score(shift);
        if e < best.1 {
            best = (shift, e);
        }
        if e < 0.4 {
            break;
        }
    }
    Some(ShiftEstimate {
        shift: best.0 as u32,
        err: best.1,
        err_at_zero,
    })
}

/// 估计「内容向上移动了多少像素」。
///
/// 仅用于采集「一格滚轮实际滚多少像素」这种标定信息，**不参与最终拼接**
/// （含吸顶/吸底固定区域的页面会让朴素 SAD 失准，正式匹配见方案第 5 节）。
pub fn estimate_shift(prev: &RgbaImage, cur: &RgbaImage) -> Option<ShiftEstimate> {
    if prev.dimensions() != cur.dimensions() {
        return None;
    }
    let (_w, h) = prev.dimensions();
    let (gp, gw, _gh) = gray_downsample(prev, 96);
    let (gc, _cw, _ch) = gray_downsample(cur, 96);
    shift_from_grays(&gp, &gc, gw as usize, h)
}

/// 粗测哪些横向分段是「不随滚动移动的固定区域」（资源管理器导航窗格、VS Code 侧栏…）。
/// 采样比对，成本很低；返回每个分段的 (x0, x1, 是否移动)。
fn detect_moving_segments(prev: &RgbaImage, cur: &RgbaImage) -> Vec<(u32, u32, bool)> {
    let (w, h) = cur.dimensions();
    let side = (w / 20).max(50).min(w / 3);
    let (x0, x1) = (side, w.saturating_sub(side));
    let seg_w = ((x1.saturating_sub(x0)).max(1) / FP_SEGMENTS).max(1);
    let mut out = Vec::with_capacity(FP_SEGMENTS as usize);
    for k in 0..FP_SEGMENTS {
        let sx0 = (x0 + k * seg_w).min(w.saturating_sub(1));
        let sx1 = if k + 1 == FP_SEGMENTS {
            x1
        } else {
            (sx0 + seg_w).min(x1)
        };
        let sx1 = sx1.max(sx0 + 1);
        let mut same = 0u32;
        let mut total = 0u32;
        let mut y = 0;
        while y < h {
            let mut x = sx0;
            while x < sx1 {
                if prev.get_pixel(x, y) == cur.get_pixel(x, y) {
                    same += 1;
                }
                total += 1;
                x += 8;
            }
            y += 8;
        }
        let frac = if total == 0 {
            1.0
        } else {
            same as f32 / total as f32
        };
        out.push((sx0, sx1, frac < 0.6));
    }
    out
}

/// 容差版位移测量：用块平均灰度的 SAD 找最佳位移。
///
/// 当**指纹匹配失败**（说明该目标的渲染不是像素级可复现：亚像素滚动重绘、
/// 文本抗锯齿抖动等）时兜底使用。**只在「会移动」的横向分段上算**——
/// 固定侧栏在 SAD 里是纯噪声，会把真正的对齐信号淹掉（资源管理器就是这么栽的）。
pub fn tolerant_shift(prev: &RgbaImage, cur: &RgbaImage) -> Option<(u32, f32)> {
    if prev.dimensions() != cur.dimensions() {
        return None;
    }
    let (_w, h) = prev.dimensions();
    let segs = detect_moving_segments(prev, cur);
    let moving: Vec<(u32, u32)> = segs
        .iter()
        .filter(|(_, _, m)| *m)
        .map(|(a, b, _)| (*a, *b))
        .collect();
    let est = if moving.is_empty() || moving.len() == segs.len() {
        estimate_shift(prev, cur)?
    } else {
        let (gp, gw, _gh) = gray_masked(prev, &moving, 96);
        let (gc, _cw, _ch) = gray_masked(cur, &moving, 96);
        shift_from_grays(&gp, &gc, gw as usize, h)?
    };
    if est.shift < MIN_SHIFT || est.err_at_zero <= f32::EPSILON {
        return None;
    }
    let ratio = est.err / est.err_at_zero;
    Some((est.shift, ratio))
}

/// 只在给定列区间上做块平均灰度降采样（区间并排拼接后降采样）
fn gray_masked(img: &RgbaImage, ranges: &[(u32, u32)], target_w: u32) -> (Vec<u8>, u32, u32) {
    let (w, h) = img.dimensions();
    let total_cols: u32 = ranges.iter().map(|(a, b)| b.saturating_sub(*a)).sum();
    if total_cols == 0 {
        return (Vec::new(), 0, 0);
    }
    let step_x = (total_cols / target_w.max(1)).max(1);
    let out_w = (total_cols / step_x).max(1);
    let raw = img.as_raw();
    let taps = step_x.min(4).max(1);
    let tap_step = (step_x / taps).max(1);
    let mut out = Vec::with_capacity((out_w * h) as usize);
    for y in 0..h {
        let base = y as usize * w as usize * 4;
        for ox in 0..out_w {
            let mut col = ox * step_x;
            let mut sum = 0u32;
            let mut n = 0u32;
            for _ in 0..taps {
                // 把拼接后的列号映射回原图列号
                let mut c = col;
                let mut x = 0u32;
                for (a, b) in ranges {
                    let span = b.saturating_sub(*a);
                    if c < span {
                        x = a + c;
                        break;
                    }
                    c -= span;
                }
                let x = x.min(w - 1);
                let i = base + x as usize * 4;
                sum += (299 * raw[i] as u32 + 587 * raw[i + 1] as u32 + 114 * raw[i + 2] as u32) / 1000;
                n += 1;
                col += tap_step;
            }
            out.push(if n == 0 { 0 } else { (sum / n) as u8 });
        }
    }
    (out, out_w, h)
}

// ---------- 窗口枚举 / 定位 ----------

fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if n <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buf[..n as usize])
    }
}

fn window_class(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    if n <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buf[..n as usize])
    }
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut v: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut v as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && v != 0
    }
}

/// 窗口外框（物理像素）
pub fn window_rect(raw: isize) -> Option<RectPx> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd_from(raw), &mut r).ok()? };
    Some(RectPx {
        x: r.left,
        y: r.top,
        w: (r.right - r.left).max(0) as u32,
        h: (r.bottom - r.top).max(0) as u32,
    })
}

/// 客户区（物理像素，虚拟桌面坐标）
pub fn client_rect(raw: isize) -> Option<RectPx> {
    unsafe {
        let hwnd = hwnd_from(raw);
        let mut r = RECT::default();
        GetClientRect(hwnd, &mut r).ok()?;
        let mut origin = POINT { x: 0, y: 0 };
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return None;
        }
        Some(RectPx {
            x: origin.x,
            y: origin.y,
            w: (r.right - r.left).max(0) as u32,
            h: (r.bottom - r.top).max(0) as u32,
        })
    }
}

fn window_info(hwnd: HWND) -> Option<WinInfo> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let raw = hwnd.0 as isize;
    Some(WinInfo {
        hwnd: raw,
        pid,
        title: window_title(hwnd),
        class: window_class(hwnd),
        rect: window_rect(raw).unwrap_or(RectPx { x: 0, y: 0, w: 0, h: 0 }),
        client: client_rect(raw).unwrap_or(RectPx { x: 0, y: 0, w: 0, h: 0 }),
        is_own: pid == std::process::id(),
    })
}

struct EnumCtx {
    items: Vec<WinInfo>,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = unsafe { &mut *(lparam.0 as *mut EnumCtx) };
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() || unsafe { IsIconic(hwnd) }.as_bool() {
        return true.into();
    }
    if is_cloaked(hwnd) {
        return true.into();
    }
    if let Some(info) = window_info(hwnd) {
        ctx.items.push(info);
    }
    true.into()
}

/// 枚举所有可见、非最小化、非 DWM cloaked 的顶层窗口
pub fn list_top_windows() -> Vec<WinInfo> {
    let mut ctx = EnumCtx { items: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut EnumCtx as isize));
    }
    ctx.items
}

/// 按 pid / 标题子串定位目标窗口（取面积最大的那个）。
/// 探针用它锁定自己刚启动的测试窗口，避免误伤用户正在用的窗口。
pub fn resolve_window(pid: Option<u32>, title_substr: Option<&str>) -> Result<WinInfo, String> {
    let needle = title_substr.map(|s| s.to_lowercase());
    let mut best: Option<WinInfo> = None;
    for w in list_top_windows() {
        if w.is_own {
            continue;
        }
        if let Some(p) = pid {
            if w.pid != p {
                continue;
            }
        }
        if let Some(n) = &needle {
            if !w.title.to_lowercase().contains(n.as_str()) {
                continue;
            }
        }
        // 过滤掉没有客户区/极小的辅助窗口
        if w.client.w < 200 || w.client.h < 200 {
            continue;
        }
        if best.as_ref().map(|b| w.rect.area() > b.rect.area()).unwrap_or(true) {
            best = Some(w);
        }
    }
    best.ok_or_else(|| {
        format!(
            "未找到匹配窗口 (pid={:?}, title~={:?})",
            pid, title_substr
        )
    })
}

/// 当前前台窗口（探针跑完后尽力恢复）
pub fn foreground_window() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

/// 把窗口带到前台（失败返回 false：Windows 会拒绝后台进程抢前台）
pub fn focus_window(raw: isize) -> bool {
    unsafe {
        let hwnd = hwnd_from(raw);
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd).as_bool()
    }
}

/// 最大化窗口（探针用：让目标窗口盖住探针自己的控制台，避免控制台污染捕获区域）
pub fn maximize_window(raw: isize) {
    unsafe {
        let _ = ShowWindow(hwnd_from(raw), SW_MAXIMIZE);
    }
}

/// 光标下最深层子窗口（`WM_MOUSEWHEEL` 的正确收件人，Chrome/Electron 的渲染子窗口在此层）。
///
/// **关键：先按 Z 序跳过本进程自己的窗口**。截图覆盖窗是 always_on_top 且铺满整屏，
/// `WindowFromPoint` 会直接返回**我们自己的覆盖窗** —— 于是滚轮消息发给自己的窗、
/// 目标窗口一动不动（P1 端到端测试逮到的 bug：命令行探针没有覆盖窗，所以一直是好的）。
/// 这里改成「自上而下枚举顶层窗口，取第一个命中该点、且不属于本进程的窗口」，
/// 与 `screenshot.rs::pick_window_at`（绿框吸附）用的是同一套 z 序逻辑。
pub fn deepest_child_at(x: i32, y: i32) -> Option<isize> {
    let top = window_below_own_at(x, y)
        .map(hwnd_from)
        .unwrap_or_else(|| unsafe { WindowFromPoint(POINT { x, y }) });
    if top.is_invalid() {
        return None;
    }
    unsafe {
        let mut cur = top;
        for _ in 0..16 {
            let mut origin = POINT { x: 0, y: 0 };
            if !ClientToScreen(cur, &mut origin).as_bool() {
                break;
            }
            // ChildWindowFromPointEx 要的是父窗口客户区坐标
            let pt = POINT {
                x: x - origin.x,
                y: y - origin.y,
            };
            let child = ChildWindowFromPointEx(cur, pt, CWP_SKIPINVISIBLE);
            if child.is_invalid() || child == cur {
                break;
            }
            cur = child;
        }
        Some(cur.0 as isize)
    }
}

/// 自上而下（Z 序）找该点处**不属于本进程**的第一个顶层窗口
pub fn window_below_own_at(x: i32, y: i32) -> Option<isize> {
    struct Ctx {
        x: i32,
        y: i32,
        own_pid: u32,
        found: Option<isize>,
    }
    unsafe extern "system" fn proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return true.into();
            }
            if is_cloaked(hwnd) {
                return true.into();
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == ctx.own_pid {
                return true.into();
            }
            if let Some(r) = window_rect(hwnd.0 as isize) {
                if r.w > 0
                    && r.h > 0
                    && ctx.x >= r.x
                    && ctx.x < r.right()
                    && ctx.y >= r.y
                    && ctx.y < r.bottom()
                {
                    ctx.found = Some(hwnd.0 as isize);
                    // EnumWindows 按 Z 序自上而下，第一个命中即最上层目标
                    return false.into();
                }
            }
        }
        true.into()
    }

    let mut ctx = Ctx {
        x,
        y,
        own_pid: std::process::id(),
        found: None,
    };
    unsafe {
        let _ = EnumWindows(Some(proc), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.found
}

/// 从任意子窗口取顶层（根）窗口
pub fn root_window(raw: isize) -> isize {
    unsafe {
        let r = GetAncestor(hwnd_from(raw), GA_ROOT);
        if r.is_invalid() {
            raw
        } else {
            r.0 as isize
        }
    }
}

/// 虚拟桌面包围盒（物理像素）：(x, y, w, h)
pub fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
        )
    }
}

/// `GetScrollInfo(SB_VERT)`：只对带标准滚动条的窗口有效（Chrome 顶层窗口没有）
pub fn scroll_state(raw: isize) -> Option<ScrollState> {    unsafe {
        let mut si = SCROLLINFO::default();
        si.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
        si.fMask = SIF_ALL;
        GetScrollInfo(hwnd_from(raw), SB_VERT, &mut si).ok()?;
        Some(ScrollState {
            min: si.nMin,
            max: si.nMax,
            pos: si.nPos,
            page: si.nPage as i32,
            track_pos: si.nTrackPos,
        })
    }
}

/// 光标下最深子窗口（优先）或顶层的滚动条状态。
///
/// **滚动条通常长在子窗口上**（ListBox / Edit / Explorer 的 DirectUIHWND），
/// 只查顶层会误判成「无滚动条」——P0 实测踩过这个坑。
pub fn scroll_state_deepest(root: isize, x: i32, y: i32) -> Option<ScrollState> {
    let target = deepest_child_at(x, y).unwrap_or(root);
    scroll_state(target).or_else(|| scroll_state(root))
}

// ---------- 滚动注入 ----------
/// 向目标窗口注入滚动。`root` 是顶层窗口，`rect` 是捕获区域（决定滚轮落点）。
/// 返回实际使用的收件人描述，便于探针输出诊断信息。
pub fn inject_scroll(
    root: isize,
    rect: &RectPx,
    method: ScrollMethod,
    notches: u32,
) -> Result<String, String> {
    let notches = notches.max(1);
    let (cx, cy) = rect.center();
    unsafe {
        match method {
            ScrollMethod::WheelPost | ScrollMethod::WheelPostRoot => {
                let target = if method == ScrollMethod::WheelPost {
                    deepest_child_at(cx, cy).unwrap_or(root)
                } else {
                    root
                };
                for _ in 0..notches {
                    // 负 delta = 向下滚
                    let delta = -(WHEEL_DELTA as i32);
                    let wparam = WPARAM(((delta as u16 as u32) << 16) as usize);
                    let lparam = LPARAM(make_lparam(cx, cy));
                    PostMessageW(Some(hwnd_from(target)), WM_MOUSEWHEEL, wparam, lparam)
                        .map_err(|e| format!("PostMessage(WM_MOUSEWHEEL) 失败: {e}"))?;
                }
                Ok(format!("WM_MOUSEWHEEL → hwnd 0x{target:X}"))
            }
            ScrollMethod::WheelInput => {
                let mut old = POINT { x: 0, y: 0 };
                let had_cursor = GetCursorPos(&mut old).is_ok();
                SetCursorPos(cx, cy).map_err(|e| format!("SetCursorPos 失败: {e}"))?;
                std::thread::sleep(Duration::from_millis(30));

                let mut input = INPUT {
                    r#type: INPUT_MOUSE,
                    ..Default::default()
                };
                input.Anonymous.mi = MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: (-(WHEEL_DELTA as i32) * notches as i32) as u32,
                    dwFlags: MOUSEEVENTF_WHEEL,
                    time: 0,
                    dwExtraInfo: 0,
                };
                let sent = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                if had_cursor {
                    let _ = SetCursorPos(old.x, old.y);
                }
                if sent == 0 {
                    return Err("SendInput 失败（可能被 UIPI 拦截）".to_string());
                }
                Ok(format!("SendInput(MOUSEEVENTF_WHEEL x{notches}) @ ({cx},{cy})"))
            }
            ScrollMethod::VScroll => {
                // 关键：滚动条长在**子窗口**上（ListBox/Edit/Explorer 的 DirectUIHWND），
                // 发给顶层窗口是无效的 —— P0 实测（WinForms ListBox）已证实这一点。
                let target = deepest_child_at(cx, cy).unwrap_or(root);
                for _ in 0..notches {
                    PostMessageW(
                        Some(hwnd_from(target)),
                        WM_VSCROLL,
                        WPARAM(SB_LINEDOWN.0 as usize),
                        LPARAM(0),
                    )
                    .map_err(|e| format!("PostMessage(WM_VSCROLL) 失败: {e}"))?;
                }
                Ok(format!("WM_VSCROLL/SB_LINEDOWN x{notches} → hwnd 0x{target:X}"))
            }
            ScrollMethod::PageDown => {
                // 同理：按键消息要发给光标下的子窗口（通常就是有焦点的那个控件），
                // 发给顶层窗口时若它自己没焦点则无人处理。
                let target = deepest_child_at(cx, cy).unwrap_or(root);
                let sc = MapVirtualKeyW(VK_NEXT.0 as u32, MAPVK_VK_TO_VSC);
                let lp_down = LPARAM((1 | ((sc as isize) << 16)) as isize);
                let lp_up = LPARAM((1 | ((sc as isize) << 16) | (1 << 30) | (1 << 31)) as isize);
                for _ in 0..notches {
                    PostMessageW(
                        Some(hwnd_from(target)),
                        WM_KEYDOWN,
                        WPARAM(VK_NEXT.0 as usize),
                        lp_down,
                    )
                    .map_err(|e| format!("PostMessage(WM_KEYDOWN) 失败: {e}"))?;
                    PostMessageW(
                        Some(hwnd_from(target)),
                        WM_KEYUP,
                        WPARAM(VK_NEXT.0 as usize),
                        lp_up,
                    )
                    .map_err(|e| format!("PostMessage(WM_KEYUP) 失败: {e}"))?;
                }
                Ok(format!("WM_KEYDOWN/UP VK_NEXT x{notches} → hwnd 0x{target:X}"))
            }
        }
    }
}

/// 把目标区域滚回顶部：向上狂发滚轮（顶部处无效滚动是安全的空操作）。
pub fn scroll_to_top(root: isize, rect: &RectPx, method: ScrollMethod, notches: u32) -> Result<(), String> {
    let (cx, cy) = rect.center();
    unsafe {
        let target = if matches!(method, ScrollMethod::WheelPost) {
            deepest_child_at(cx, cy).unwrap_or(root)
        } else {
            root
        };
        match method {
            ScrollMethod::WheelPost | ScrollMethod::WheelPostRoot | ScrollMethod::WheelInput => {
                let mut old = POINT { x: 0, y: 0 };
                let had_cursor = GetCursorPos(&mut old).is_ok();
                if matches!(method, ScrollMethod::WheelInput) {
                    let _ = SetCursorPos(cx, cy);
                    std::thread::sleep(Duration::from_millis(20));
                }
                for _ in 0..notches {
                    if matches!(method, ScrollMethod::WheelInput) {
                        let mut input = INPUT {
                            r#type: INPUT_MOUSE,
                            ..Default::default()
                        };
                        input.Anonymous.mi = MOUSEINPUT {
                            dx: 0,
                            dy: 0,
                            mouseData: WHEEL_DELTA,
                            dwFlags: MOUSEEVENTF_WHEEL,
                            time: 0,
                            dwExtraInfo: 0,
                        };
                        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                    } else {
                        let wparam = WPARAM(((WHEEL_DELTA as u16 as u32) << 16) as usize);
                        PostMessageW(
                            Some(hwnd_from(target)),
                            WM_MOUSEWHEEL,
                            wparam,
                            LPARAM(make_lparam(cx, cy)),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
                if matches!(method, ScrollMethod::WheelInput) && had_cursor {
                    let _ = SetCursorPos(old.x, old.y);
                }
                Ok(())
            }
            // 键/滚动条方式没有「回到顶部」的单步原语，交给调用方处理
            _ => Err("该方法不支持回到顶部".to_string()),
        }
    }
}

// ============================================================
// P1：纵向拼接
// ============================================================

/// 匹配参数
#[derive(Debug, Clone, Copy)]
pub struct MatchParams {
    /// 认定的最小重叠行数：短于此视为匹配失败
    pub min_overlap: u32,
    /// 行指纹的采样列步长（每 N 列取 1 个样本）
    pub fp_step: u32,
}

impl MatchParams {
    pub fn for_height(h: u32) -> Self {
        Self {
            min_overlap: (h / 10).clamp(16, 240),
            fp_step: 4,
        }
    }
}

/// 两帧之间的纵向匹配结果
#[derive(Debug, Clone, Copy)]
pub struct MatchResult {
    /// 位移：这一帧页面往上滚了多少物理像素
    pub shift: u32,
    /// 该位移下最长连续匹配行数（置信度的直接来源）
    pub run: u32,
    /// 顶部固定带高度（吸顶导航/标题栏：两帧在同一位置完全相同）
    pub top_fixed: u32,
    /// 底部固定带高度（吸底工具栏/输入框：两帧在同一位置完全相同）
    pub bottom_fixed: u32,
    /// 是否存在另一个同样可信、但位移明显不同的候选（周期性内容歧义）
    pub ambiguous: bool,
    /// 次优候选位移（诊断用）
    pub runner_up: Option<u32>,
    /// 在动态安全区内支持该位移的图像块比例（0-1）
    pub block_inlier_ratio: f32,
    /// 动态安全区内的平均像素残差（0-255，越小越好）
    pub mean_block_error: f32,
    /// 最优位移相对次优位移的残差优势（0-1，越大越可区分）
    pub runner_up_gap: f32,
}

/// 行指纹：把一行的采样列量化后哈希成 64 位。
///
/// 量化（每通道 `>>3`，即 5 bit）是为了吸收极少量非确定性渲染差异（次像素抗锯齿、
/// GPU 取整抖动等），又不至于把不同内容混同。
fn row_fingerprints(img: &RgbaImage, x0: u32, x1: u32, step: u32) -> Vec<u64> {
    let (w, h) = img.dimensions();
    let raw = img.as_raw();
    let mut out = Vec::with_capacity(h as usize);
    let step = step.max(1);
    for y in 0..h {
        let base = y as usize * w as usize * 4;
        let mut hsh: u64 = 0xcbf2_9ce4_8422_2325;
        let mut x = x0;
        while x < x1 {
            let i = base + x as usize * 4;
            let packed = ((raw[i] >> 3) as u64) << 10
                | ((raw[i + 1] >> 3) as u64) << 5
                | (raw[i + 2] >> 3) as u64;
            hsh = (hsh ^ packed).wrapping_mul(0x0000_0100_0000_01b3);
            x += step;
        }
        out.push(hsh);
    }
    out
}

/// 横向切成几段做指纹
const FP_SEGMENTS: u32 = 5;

/// 分段行指纹网格。
///
/// **为什么要分段**：真实应用里经常存在**不随滚动移动的区域**——资源管理器的导航窗格、
/// VS Code 的侧边栏、网页的固定侧栏。整行只算一个指纹时，只要行内有一段是静止的，
/// 这一行就永远对不上，长重叠区根本跑不出来（P1 实测：资源管理器会话直接被判「滚不动」）。
///
/// **为什么不能只做「多数段相同」**：那样会让错误的位移也能过 —— 等距同款列表里
/// 相邻行只有行号不同，多数段照样相同，于是「滚了 3 行」会被认成「滚了 1 行」
/// （P1 实测：ListBox 会话每步只前进 1/3 的内容，跑满 200 帧上限）。
///
/// 现在的规则：先按「两帧在同一行下标处是否相同」把**整段静止的段**识别出来并忽略，
/// 其余段必须**全部严格相同**才算这一行匹配。既有固定侧栏也不会僵死，又保留了
/// 「行号不同就不算匹配」的判别力。
struct FpGrid {
    segs: Vec<Vec<u64>>,
    /// 该段是否随滚动移动（false = 固定区域，不参与匹配）
    moving: Vec<bool>,
    /// 是否存在固定段（用于诊断）
    has_static: bool,
}

impl FpGrid {
    /// 同时构建两帧的网格，并让它们共享同一份 `moving` 判据
    fn pair(
        prev: &RgbaImage,
        cur: &RgbaImage,
        x0: u32,
        x1: u32,
        step: u32,
        segments: u32,
    ) -> (Self, Self) {
        let segments = segments.max(1);
        let span = x1.saturating_sub(x0).max(1);
        let seg_w = (span / segments).max(1);
        let h = cur.height().min(prev.height()) as usize;
        let mut segs_prev = Vec::with_capacity(segments as usize);
        let mut segs_cur = Vec::with_capacity(segments as usize);
        let mut moving = Vec::with_capacity(segments as usize);
        for k in 0..segments {
            let sx0 = (x0 + k * seg_w).min(cur.width().saturating_sub(1));
            let sx1 = if k + 1 == segments {
                x1
            } else {
                (sx0 + seg_w).min(x1)
            };
            let sx1 = sx1.max(sx0 + 1).min(cur.width());
            let fp_prev = row_fingerprints(prev, sx0, sx1, step);
            let fp_cur = row_fingerprints(cur, sx0, sx1, step);
            // 「同一行下标处相同」的比例高 = 这一段整体没动（固定区域）
            let same = (0..h)
                .filter(|y| fp_prev[*y] == fp_cur[*y])
                .count();
            let frac = if h == 0 { 1.0 } else { same as f32 / h as f32 };
            moving.push(frac < 0.5);
            segs_prev.push(fp_prev);
            segs_cur.push(fp_cur);
        }
        // 全段静止说明两帧几乎一致（调用方另有「到底」判定），此时退回全段参与匹配
        let has_static = moving.iter().any(|m| !*m);
        if !moving.iter().any(|m| *m) {
            moving.iter_mut().for_each(|m| *m = true);
        }
        (
            Self { segs: segs_prev, moving: moving.clone(), has_static },
            Self { segs: segs_cur, moving, has_static },
        )
    }

    /// `self[cur_y]` 与 `other[prev_y]` 是否算「同一行内容」：
    /// **所有移动段都必须严格相同**（固定段不参与）
    #[inline]
    fn row_match(&self, other: &FpGrid, cur_y: usize, prev_y: usize) -> bool {
        for k in 0..self.segs.len() {
            if !self.moving[k] {
                continue;
            }
            if self.segs[k][cur_y] != other.segs[k][prev_y] {
                return false;
            }
        }
        true
    }

    /// 同一位置（用于识别吸顶/吸底固定带）
    #[inline]
    fn same_row(&self, other: &FpGrid, y: usize) -> bool {
        self.row_match(other, y, y)
    }
}

/// 对行指纹给出的候选位移做一次容差像素复核。
///
/// 行指纹只负责快速找候选；置信度应来自真实重叠区有多少小块支持这个位移，
/// 而不是新追加内容是否恰好和旧内容里某些空白行相同。固定页头/页脚与左右边缘
/// 均不参与，以形成用于注册的动态安全区。
fn block_registration_quality(
    prev: &RgbaImage,
    cur: &RgbaImage,
    side: u32,
    top_fixed: u32,
    bottom_fixed: u32,
    shift: u32,
) -> (f32, f32) {
    let (w, h) = cur.dimensions();
    let y0 = top_fixed.min(h);
    let y1 = h.saturating_sub(bottom_fixed).saturating_sub(shift);
    let x0 = side.min(w);
    let x1 = w.saturating_sub(side);
    if y1 <= y0 || x1 <= x0 {
        return (0.0, f32::INFINITY);
    }

    const BLOCK_H: u32 = 24;
    const SAMPLE_X: u32 = 8;
    const SAMPLE_Y: u32 = 4;
    const INLIER_ERROR: f32 = 10.0;
    let a = prev.as_raw();
    let b = cur.as_raw();
    let mut blocks = 0u32;
    let mut inliers = 0u32;
    let mut error_sum = 0.0f32;

    let mut by = y0;
    while by < y1 {
        let by_end = (by + BLOCK_H).min(y1);
        let mut sum = 0u64;
        let mut samples = 0u64;
        let mut y = by;
        while y < by_end {
            let mut x = x0;
            while x < x1 {
                let ci = ((y * w + x) * 4) as usize;
                let pi = (((y + shift) * w + x) * 4) as usize;
                sum += (b[ci] as i16 - a[pi] as i16).unsigned_abs() as u64;
                sum += (b[ci + 1] as i16 - a[pi + 1] as i16).unsigned_abs() as u64;
                sum += (b[ci + 2] as i16 - a[pi + 2] as i16).unsigned_abs() as u64;
                samples += 3;
                x += SAMPLE_X;
            }
            y += SAMPLE_Y;
        }
        if samples > 0 {
            let error = sum as f32 / samples as f32;
            error_sum += error;
            blocks += 1;
            if error <= INLIER_ERROR {
                inliers += 1;
            }
        }
        by = by_end;
    }
    if blocks == 0 {
        (0.0, f32::INFINITY)
    } else {
        (inliers as f32 / blocks as f32, error_sum / blocks as f32)
    }
}

/// 在 `prev` / `cur` 之间找纵向位移（= 这一帧页面往上滚了多少像素）。
///
/// `prior_shift` 是上一步（或探针）测得的位移，用来在**周期性内容**造成的多解里挑最合理的
/// 那个：滚动步长是稳定的，所以「离上一步最近的可信候选」几乎总是正确答案。
///
/// 返回 `None` = 没有可信匹配（画面跳变、动态内容、纯色区域等）。
pub fn match_frames(
    prev: &RgbaImage,
    cur: &RgbaImage,
    params: &MatchParams,
    prior_shift: Option<u32>,
) -> Option<MatchResult> {
    let (w, h) = cur.dimensions();
    if prev.dimensions() != cur.dimensions() || h < 16 || w < 16 {
        return None;
    }
    // 左右各忽略一部分（躲滚动条/边框/侧边栏）——P0/ShareX 一致的做法
    let side = (w / 20).max(50).min(w / 3);
    let (x0, x1) = (side, w.saturating_sub(side));
    if x1 <= x0 + 8 {
        return None;
    }
    let (fp_prev, fp_cur) = FpGrid::pair(prev, cur, x0, x1, params.fp_step, FP_SEGMENTS);

    // 顶部/底部固定带（同位置行指纹相同的最长前缀/后缀）
    let cap = h / 3;
    let mut top_fixed = 0u32;
    while top_fixed < cap && fp_cur.same_row(&fp_prev, top_fixed as usize) {
        top_fixed += 1;
    }
    let mut bottom_fixed = 0u32;
    while bottom_fixed < cap
        && bottom_fixed < h - 1
        && fp_cur.same_row(&fp_prev, (h - 1 - bottom_fixed) as usize)
    {
        bottom_fixed += 1;
    }

    // 候选位移：s ∈ [1, h - bottom_fixed - min_overlap]
    let s_max = h
        .saturating_sub(bottom_fixed)
        .saturating_sub(params.min_overlap);
    if s_max < 1 {
        return None;
    }
    let mut cands: Vec<(u32, u32)> = Vec::new(); // (shift, longest_run)
    for s in 1..=s_max {
        let n = h - bottom_fixed - s; // 重叠行数
        let mut run = 0u32;
        let mut best_run = 0u32;
        for y in 0..n {
            if fp_cur.row_match(&fp_prev, y as usize, (y + s) as usize) {
                run += 1;
                if run > best_run {
                    best_run = run;
                }
            } else {
                run = 0;
            }
        }
        if best_run >= params.min_overlap {
            cands.push((s, best_run));
        }
    }
    if cands.is_empty() {
        return None;
    }

    let best_run = cands.iter().map(|(_, r)| *r).max().unwrap_or(0);
    // 峰值候选（最长连续匹配；周期内容下会偏向最小可行位移 = 保守：宁可少追加也不重复内容）
    let peak = *cands
        .iter()
        .max_by_key(|(s, r)| (*r, std::cmp::Reverse(*s)))
        .map(|(s, _)| s)
        .unwrap_or(&cands[0].0);

    let chosen = match prior_shift.filter(|p| *p >= MIN_SHIFT) {
        // 有先验（上一步/探针测得的位移）：在合理范围里挑**离先验最近**的候选。
        // 这一步是周期性内容能不能拼对的关键：等距同款列表里 s 与 s±k·period 全都「对得上」，
        // 只有先验能区分；而「最长 run」永远偏向最小位移，会把位移越拼越小。
        Some(prior) => cands
            .iter()
            .filter(|(s, _)| *s <= prior.saturating_mul(4).max(MIN_SHIFT) && *s * 4 >= prior)
            .min_by_key(|(s, r)| (s.abs_diff(prior), std::cmp::Reverse(*r)))
            .map(|(s, _)| *s)
            .unwrap_or(peak),
        None => peak,
    };

    let mut contenders: Vec<(u32, u32)> = cands
        .iter()
        .copied()
        .filter(|(_, r)| (*r as f32) >= best_run as f32 * 0.85)
        .collect();
    contenders.sort_by_key(|(s, _)| *s);

    let chosen_run = cands
        .iter()
        .find(|(s, _)| *s == chosen)
        .map(|(_, r)| *r)
        .unwrap_or(best_run);
    let spread = contenders
        .iter()
        .map(|(s, _)| *s)
        .max()
        .unwrap_or(0)
        .saturating_sub(contenders.iter().map(|(s, _)| *s).min().unwrap_or(0));
    // 判歧义：存在另一个同样可信、但位移差得够远的候选。
    // 阈值取 max(24px, 最佳位移的 10%)：周期性内容（等距同款列表）正是这种情形。
    let ambiguous = contenders.len() > 1 && spread > (chosen / 10).max(24);
    let runner_up = contenders
        .iter()
        .filter(|(s, _)| *s != chosen)
        .max_by_key(|(_, r)| *r)
        .map(|(s, _)| *s);
    let (block_inlier_ratio, mean_block_error) =
        block_registration_quality(prev, cur, side, top_fixed, bottom_fixed, chosen);
    let runner_up_gap = runner_up
        .map(|s| {
            let (_, runner_error) =
                block_registration_quality(prev, cur, side, top_fixed, bottom_fixed, s);
            if !runner_error.is_finite() {
                1.0
            } else {
                (runner_error - mean_block_error).max(0.0) / runner_error.max(1.0)
            }
        })
        .unwrap_or(1.0);

    Some(MatchResult {
        shift: chosen,
        run: chosen_run,
        top_fixed,
        bottom_fixed,
        ambiguous,
        runner_up,
        block_inlier_ratio,
        mean_block_error,
        runner_up_gap,
    })
}

/// 单行指纹（整行采样 + 量化哈希）。用于「查重」——只关心两行是不是同一行内容。
fn row_hash(raw: &[u8], row_index: usize, w: u32, step: u32) -> u64 {
    let base = row_index * w as usize * 4;
    let mut hsh: u64 = 0xcbf2_9ce4_8422_2325;
    let mut x = 0u32;
    while x < w {
        let i = base + x as usize * 4;
        let packed = ((raw[i] >> 3) as u64) << 10
            | ((raw[i + 1] >> 3) as u64) << 5
            | (raw[i + 2] >> 3) as u64;
        hsh = (hsh ^ packed).wrapping_mul(0x0000_0100_0000_01b3);
        x += step;
    }
    hsh
}

/// **追加前查重**：即将追加的**新内容**（不含吸底栏）有多大比例已经存在于画布尾部？
///
/// ⚠ 这个指标**只能当参考，不能当否决票**（实测踩过）：它按「整行 64 位哈希完全相同」计数，
/// 而真实网页里大量行本来就长得一样（空白、纯色、重复正文、条纹）。于是**位移完全正确**时
/// 它照样可能报 80%+，把好帧全否掉 → 一帧都拼不上 → 报「没有捕获到可拼接的内容」。
/// 现在的用法：只在「匹配本身就很弱」时把它当作提前收兵的依据，并且**永远不丢帧**
/// （见主循环里对 `dup` 的处理：接受 + 标记低置信）。
///
/// `band_end` 由调用方给（= 帧高 - 吸底栏高）：吸底栏每步都必然与上一帧不同（含滚动位置
/// 提示时），算进来会每步都误判。
///
/// 返回 0.0-1.0；没有可比对的行时返回 0.0（不误报）。
fn duplicate_ratio(
    canvas: &[u8],
    canvas_w: u32,
    canvas_h: u32,
    cur: &RgbaImage,
    append_y: u32,
    band_end: u32,
) -> f32 {
    // 只检查「新内容」部分：吸底栏那几行天然与上一帧相同，不能算重复
    let band_end = band_end.min(cur.height());
    let band_rows = band_end.saturating_sub(append_y);
    if band_rows == 0 || canvas_h == 0 || canvas_w != cur.width() {
        return 0.0;
    }
    // 尾部一屏以内的行作为参照（再往前的重复属于「隔很远才重复」，噪声更大）
    let tail_rows = canvas_h.min(cur.height());
    let tail_start = canvas_h - tail_rows;
    let step = 4u32;
    let mut seen: std::collections::HashSet<u64> =
        std::collections::HashSet::with_capacity(tail_rows as usize);
    for y in tail_start..canvas_h {
        seen.insert(row_hash(canvas, y as usize, canvas_w, step));
    }
    let raw = cur.as_raw();
    let mut hits = 0u32;
    // 只比对「新内容」行（不含吸底栏）
    for y in append_y..band_end {
        if seen.contains(&row_hash(raw, y as usize, canvas_w, step)) {
            hits += 1;
        }
    }
    hits as f32 / band_rows as f32
}

/// 把 `cur` 的正文新内容接到累积画布上。
///
/// **约定：画布只保存「吸顶页头 + 累积正文」，不保存吸底栏**（吸底栏在收尾时补一次，
/// 见 `run_session` 末尾的 `attach_footer`）。这样拼接算式最干净：
///
/// - 页面往上滚了 `shift` ⇒ `cur` 里最新的正文是正文区最后 `shift` 行，
///   即整帧的 `cur[h-shift-footer_h .. h-footer_h)`。
/// - 画布尾部 `shift` 行是上一帧写进去的同一段正文，丢掉后再追加这 `shift` 行。
/// - 于是画布**净增恰好 = shift** —— 核心不变量。
/// - 起始帧（`shift = 0`）：写入 `header + body`（不含吸底栏）。
///
/// ⚠ 早期版本用 `append_y = h - bottom_fixed - shift`（且只丢 `bottom_fixed` 行）：
/// 净增只有 `shift - bottom_fixed`。页脚一大（浏览器固定工具条 30-60px）净增就≈0，
/// 画布永远超不过一帧 —— 表现就是「只拼进 1 帧」，最后报「没有捕获到可拼接的内容」。
/// 另外「最后一帧的最后 `shift` 行」会把上一帧的正文行覆盖成新吸底栏（实测行号跳变），
/// 所以这里改成「划出正文区 + 收尾单独贴吸底栏」。有
/// `stitch_reproduces_expected_long_image` 断言住这些不变量。
fn append_band(
    canvas: &mut Vec<u8>,
    canvas_w: u32,
    canvas_h: &mut u32,
    cur: &RgbaImage,
    header_h: u32,
    footer_h: u32,
    shift: u32,
) -> Result<(), String> {
    let h = cur.height();
    if canvas_w == 0 || h == 0 {
        return Err("append_band: 空帧".to_string());
    }
    if cur.width() != canvas_w {
        return Err(format!(
            "append_band: 帧宽 {} 与画布宽 {canvas_w} 不一致",
            cur.width()
        ));
    }
    let row_bytes = canvas_w as usize * 4;
    let header_h = header_h.min(h / 2);
    let footer_h = footer_h.min(h.saturating_sub(header_h).saturating_sub(1));
    let body_bottom = h - footer_h;
    if body_bottom <= header_h {
        return Err("append_band: 帧高不足以容纳页头/页脚".to_string());
    }
    let raw = cur.as_raw();
    if shift == 0 {
        // 起始帧：页头 + 正文（吸底栏留给收尾）
        canvas.extend_from_slice(&raw[..body_bottom as usize * row_bytes]);
        *canvas_h += body_bottom;
        return Ok(());
    }
    let shift = shift.min(*canvas_h);
    // 正文区高度（画布只存 页头+正文，所以可直接按行数换算）
    let body_h = h - header_h - footer_h;
    // 本帧正文里最新的 shift 行：正文下标 (body_h - shift)，换算到整帧下标要加 header_h
    let new_start = body_h.saturating_sub(shift) + header_h;
    // 画布**全保留**：画布尾部就是上一帧正文的末尾，正好等于本帧新内容的前一行
    // （画布不含吸底栏，所以不存在「旧吸底栏要被覆盖」的问题）
    canvas.extend_from_slice(&raw[new_start as usize * row_bytes..body_bottom as usize * row_bytes]);
    *canvas_h += body_bottom - new_start;
    debug_assert_eq!(
        canvas.len(),
        *canvas_h as usize * row_bytes,
        "画布长度与行数记账不一致"
    );
    Ok(())
}

/// 收尾：把最后一帧的吸底栏贴到长图最底部（整个会话只出现一次）。
fn attach_footer(canvas: &mut Vec<u8>, canvas_w: u32, canvas_h: &mut u32, last: &RgbaImage, footer_h: u32) {
    let h = last.height();
    let footer_h = footer_h.min(h.saturating_sub(1));
    if footer_h == 0 || last.width() != canvas_w {
        return;
    }
    let row_bytes = canvas_w as usize * 4;
    let raw = last.as_raw();
    canvas.extend_from_slice(&raw[(h - footer_h) as usize * row_bytes..]);
    *canvas_h += footer_h;
}

/// 首帧在还不知道吸底栏高度时会完整入画布。第一对帧匹配出吸底栏后，
/// 必须把这块从首帧尾部拿掉：后续 `append_band` 的不变量是「画布只存
/// 页头 + 正文」，否则首帧页脚会烤进长图中间，最后收尾又会再贴一次页脚。
fn trim_initial_footer(canvas: &mut Vec<u8>, canvas_w: u32, canvas_h: &mut u32, footer_h: u32) -> bool {
    if canvas_w == 0 || footer_h == 0 || footer_h > *canvas_h {
        return false;
    }
    let bytes = footer_h as usize * canvas_w as usize * 4;
    if bytes > canvas.len() {
        return false;
    }
    canvas.truncate(canvas.len() - bytes);
    *canvas_h -= footer_h;
    true
}

// ============================================================
// P1：实时预览（缩略图）
// ============================================================

/// 增量缩略图：每追加一段就往预览里贴一段，避免每帧重算整张长图（那是 O(H²)）。
struct PreviewBuilder {
    width: u32,
    scale: f32,
    img: RgbaImage,
}

impl PreviewBuilder {
    fn new(canvas_w: u32, width: u32) -> Self {
        let scale = width as f32 / canvas_w.max(1) as f32;
        Self {
            width,
            scale,
            img: RgbaImage::new(width, 0),
        }
    }

    /// 把「画布行区间 `canvas_y0..`」对应的一小段像素贴进预览
    fn append_strip(&mut self, strip: &RgbaImage, canvas_y0: u32) {
        if strip.height() == 0 {
            return;
        }
        let py0 = (canvas_y0 as f32 * self.scale).round() as u32;
        let py1 = ((canvas_y0 + strip.height()) as f32 * self.scale).round().max(py0 as f32 + 1.0) as u32;
        let ph = py1 - py0;
        let scaled = image::imageops::resize(
            strip,
            self.width,
            ph,
            image::imageops::FilterType::Triangle,
        );
        if self.img.height() < py1 {
            let mut bigger = RgbaImage::new(self.width, py1);
            image::imageops::overlay(&mut bigger, &self.img, 0, 0);
            self.img = bigger;
        }
        image::imageops::overlay(&mut self.img, &scaled, 0, py0 as i64);
    }

    /// 导出给前端的 data URL（超过 `max_h` 就整体压扁，保证 IPC 负载恒定）
    fn data_url(&self, max_h: u32) -> Option<String> {
        if self.img.height() == 0 {
            return None;
        }
        let out = if self.img.height() > max_h {
            image::imageops::resize(
                &self.img,
                self.width,
                max_h,
                image::imageops::FilterType::Triangle,
            )
        } else {
            self.img.clone()
        };
        let png = encode_png(&out, false).ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png)
        ))
    }
}

/// PNG 编码。`small = true` 用 Fast/NoFilter（预览，追求速度）；否则用 Default/Adaptive
/// （最终长图，追求体积——20000px 高的长图用 NoFilter 能到几十 MB）。
fn encode_png(img: &RgbaImage, small: bool) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let (ct, ft) = if small {
        (CompressionType::Fast, FilterType::NoFilter)
    } else {
        (CompressionType::Default, FilterType::Adaptive)
    };
    PngEncoder::new_with_quality(&mut out, ct, ft)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(out)
}

// ============================================================
// P1：会话
// ============================================================

/// 一次滚动截图的请求参数（前端 `start_scroll_capture` 的入参）
#[derive(Debug, Clone, Deserialize)]
pub struct ScrollCaptureRequest {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
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
}

impl ScrollCaptureRequest {
    pub fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
        Self {
            x,
            y,
            w,
            h,
            method: None,
            notches: None,
            settle_timeout_ms: None,
            poll_ms: None,
            auto_scroll_top: None,
            max_height_px: None,
            max_frames: None,
            focus_target: None,
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
            Some(other) => Some(ScrollMethod::parse(other).ok_or_else(|| format!("未知滚动方式: {other}"))?),
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
    /// probing | capturing | matched | low_confidence | done | partial | failed | cancelled
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
    fn bare(stage: &str, rect: &RectPx) -> Self {
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
    fn with_capture(mut self, cap: &RectPx) -> Self {
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
    /// 注册/注销临时全局 Esc（click-through 时 HUD 按钮点不到，这是安全出口）
    fn set_escape_hook(&self, on: bool);
    /// 捕获期间的任务栏进度指示（覆盖窗里没空地放 HUD 时的唯一可见反馈）。
    /// 默认空实现，命令行探针不需要。
    fn set_progress(&self, _running: bool, _ratio: f32) {}
}

/// 无需宿主能力的空实现（命令行/单测用）
pub struct NoHost;
impl SessionHost for NoHost {
    fn set_passthrough(&self, _on: bool) {}
    fn focus_target(&self, _hwnd: isize) {}
    fn set_escape_hook(&self, _on: bool) {}
}

/// 容差路径的额外门槛：绝对误差也不能太大（否则是「画面全变了」而不是「亚像素重绘」）
fn est_err_ok(prev: &RgbaImage, cur: &RgbaImage) -> bool {
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
    let mut bottom_limit = rect.y.saturating_add(vh as i32);
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
fn with_cursor_at<F>(rect: &RectPx, method: ScrollMethod, f: F) -> Result<String, String>
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
    /// 是否启用（前端没报「HUD 压在捕获区上」时全程不触发，零开销）
    enabled: bool,
}

impl FrameHideGate {
    pub fn new(cb: Option<Box<dyn FnMut(bool) + Send>>) -> Self {
        Self { cb, hiding: false, hidden: false, enabled: false }
    }

    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
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
            std::thread::sleep(Duration::from_millis(120));
        }
    }

    /// 抓帧结束：恢复宿主 UI
    pub fn end_frame(&mut self) {
        if !self.hiding {
            return;
        }
        self.hiding = false;
        if self.hidden {
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
struct SessionCleanup<'a> {
    host: &'a dyn SessionHost,
    /// 采帧期间的 HUD 让位开关（随租约一起兜底还原）
    gate: Rc<RefCell<FrameHideGate>>,
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
struct SessionLog {
    file: Option<std::fs::File>,
}

impl SessionLog {
    fn open(tag: &str) -> Self {
        let on = std::env::var("CLOVER_SCROLL_DEBUG").map(|v| v != "0" && !v.is_empty()).unwrap_or(false);
        if !on {
            return Self { file: None };
        }
        let path = std::env::temp_dir().join("clover_scroll_debug.log");
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok();
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

    fn log(&mut self, msg: &str) {
        use std::io::Write;
        let Some(f) = self.file.as_mut() else { return };
        let _ = writeln!(f, "{msg}");
        let _ = f.flush();
    }
}

/// 跑完整个滚动截图会话（探测 → 逐帧捕获拼接 → 返回长图 PNG）。
///
/// 这是 P1 的核心：Tauri 命令与命令行探针共用同一份实现。
pub fn run_session(
    req: &ScrollCaptureRequest,
    o: &SessionOptions,
    host: &dyn SessionHost,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(ScrollCaptureProgress),
) -> Result<ScrollCaptureResult, String> {
    run_session_ext(req, o, host, cancel, None, None, on_progress)
}

/// `run_session` 的扩展版：多一个「采帧前后通知宿主」的回调。
///
/// Tauri 侧用它通知前端在采帧瞬间把 HUD 让开——覆盖窗是透明 WebView，正常情况下
/// 不会被 `BitBlt` 截进去（已实测：整屏选区的长图里没有 UI），但**整屏/整窗选区**
/// 时 HUD 只能压在被捕获的画面上，留这一手保险比事后在长图里发现一个提示框便宜。
/// 命令行探针传 `None`，行为与以前完全一致。
pub fn run_session_ext(
    req: &ScrollCaptureRequest,
    o: &SessionOptions,
    host: &dyn SessionHost,
    cancel: &AtomicBool,
    hud_overlap: Option<&AtomicBool>,
    on_frame_capture: Option<Box<dyn FnMut(bool) + Send>>,
    on_progress: &mut dyn FnMut(ScrollCaptureProgress),
) -> Result<ScrollCaptureResult, String> {
    let rect = req.rect();
    if rect.w < 32 || rect.h < 64 {
        return Err("选区太小：滚动截图至少需要 32×64 像素".to_string());
    }

    let (cx, cy) = rect.center();
    let deepest = deepest_child_at(cx, cy).ok_or_else(|| "选区内没有可操作的目标窗口".to_string())?;
    let root = root_window(deepest);
    {
        // 诊断：把「最终认定的目标窗口」写进日志。多屏/覆盖窗/置顶窗叠在一起时，
        // 光看现象根本分不清滚轮到底发给了谁（P1 端到端就是这么被抓出来的）。
        let info = window_info(hwnd_from(root));
        tracing::info!(
            "滚动截图: 目标窗口 0x{root:X} class={} title={} (命中点 {cx},{cy})",
            info.as_ref().map(|w| w.class.clone()).unwrap_or_default(),
            info.as_ref().map(|w| w.title.clone()).unwrap_or_default()
        );
    }

    // 采帧期间让前端 HUD 让开（仅当它压在捕获区上时；见 `run_session_ext` 的说明）
    let frame_gate = Rc::new(RefCell::new(FrameHideGate::new(on_frame_capture)));
    let mut hud_overlap_live = hud_overlap.map(|f| f.load(Ordering::Relaxed)).unwrap_or(false);
    frame_gate.borrow_mut().set_enabled(hud_overlap_live);
    tracing::info!("滚动截图: 采帧时隐藏 HUD = {hud_overlap_live}");

    // 会话期间光标一律停在选区外（避免悬停高亮污染帧），结束时恢复
    let mut original_cursor = POINT { x: 0, y: 0 };
    let had_cursor = unsafe { GetCursorPos(&mut original_cursor).is_ok() };
    let _cursor_guard = CursorGuard { had: had_cursor, pos: original_cursor };

    // 实际捕获区：矮选区向下补足（宽度不变）。逐帧捕获与前端的「挖空范围」都用它。
    // 只有**确实太矮**的选区才补足高度：
    // 一次滚轮最多约 200px（DPI 125% 下 Chrome 约 125-190px），所以选区只要 ≥500px 高，
    // 一步滚完仍留 300px 以上重叠区 —— 完全不需要补。
    // 早期写成「补到选区高度的 2.5 倍」，而 2.5h > h 恒成立 → **每次都会补**，于是每次都在
    // 选区下方多出一条亮带（补出来的区域必须保持透明，否则遮罩会被截进长图），
    // 看起来就像选区自己变大了（用户实测报回）。现在常见选区根本不会补，界面干净。
    // 选区高度硬下限：低于 280px 时，常见的一格滚轮已经会吃光重叠区。
    // 280-399px 允许启动，等首个真实滚动测得位移后再做准确判定；400px 只是前端推荐值。
    //
    // 早期做法是「偷偷把捕获高度往上补」：补出来的区域**必须保持透明**（否则我们自己的压暗
    // 遮罩会被截进长图），于是界面上会多出一条亮带；而选区那条边框线又会落进捕获区里被截进
    // 长图（用户实测报回「绿线又回来了」）。与其做这种自相矛盾的补救，不如直接要求框高一点：
    // 诚实、界面干净、没有意外。
    const MIN_SELECTION_H: u32 = 280;
    if rect.h < MIN_SELECTION_H {
        return Err(format!(
            "选区太矮：至少需要 {}px 高（当前 {}px）。请拉高选区后重试。",
            MIN_SELECTION_H, rect.h
        ));
    }
    // 不再补足：捕获区 = 选区，
    // 于是边框永远画在捕获区之外，也就不可能被截进长图。
    let cap = rect;
    let mut dlog = SessionLog::open(&format!(
        "run_session rect={},{},{}x{}",
        rect.x, rect.y, rect.w, rect.h
    ));
    let wheel_like = |m: ScrollMethod| {
        matches!(
            m,
            ScrollMethod::WheelPost | ScrollMethod::WheelPostRoot | ScrollMethod::WheelInput
        )
    };

    // 会话收尾的兜底租约：**必须在任何可能 `?` 提前返回的操作之前**声明，
    // 否则又会出现「早期返回时覆盖窗留在 click-through、全局 Esc 没注销」的泄漏。
    let session_cleanup = SessionCleanup {
        host,
        gate: frame_gate.clone(),
    };

    if o.focus_target {
        host.focus_target(root);
        std::thread::sleep(Duration::from_millis(120));
    }
    host.set_escape_hook(true);
    {
        let deep = deepest_child_at(cx, cy);
        dlog.log(&format!(
            "target root=0x{root:X} deepest={} park={:?} vscroll(root)={:?} vscroll(deep)={:?}",
            deep.map(|h| format!("0x{h:X}")).unwrap_or_else(|| "none".into()),
            park_point(&cap),
            scroll_state(root),
            deep.and_then(scroll_state)
        ));
    }

    // ---- 1. 可选：回到顶部 ----
    //
    // **默认关闭**：默认行为是「从用户当前看到的位置顺着往下截」——框了一块内容就期待
    // 「从这儿开始一直往下」，而不是先跳到页面顶部（那是另一个意图，交给用户显式开启）。
    if o.auto_scroll_top {
        let m = o.method.unwrap_or(ScrollMethod::WheelPost);
        if wheel_like(m) {
            tracing::info!("滚动截图: 按设置先回到顶部");
            let _ = with_cursor_at(&cap, m, || {
                scroll_to_top(root, &cap, m, 60).map(|_| "scroll_to_top".to_string())
            });
            std::thread::sleep(Duration::from_millis(o.poll_ms));
        }
    }

    // ---- 2. 注入方式不预判：主循环里边滚边选 ----
    //
    // 早期实现会先「滚一格试一下」来挑方式并标定每格像素，代价是用户先看到画面跳一下
    // （回顶时再跳回去）——体验差。实际上**试错失败时画面根本不会动**（这正是失败的定义），
    // 所以完全可以把试错放进主循环：挨个试，谁先让画面动起来就用谁，而且成功那一次
    // 本身就是第一帧内容，不浪费、不抖动。
    let mut method: Option<ScrollMethod> = o.method;
    let mut notches = o.notches.unwrap_or(1);
    /// 主循环里「挨个试」的注入方式顺序：先试最通用的滚轮消息，再退化到模拟滚轮 / 翻页 / 滚动条。
    /// 顺序有讲究：`wheel_post_root` 只在「最深子窗口不处理滚轮」时才需要（Chrome 这类
    /// 自绘窗口的中间层子窗口就是这种情况），所以排在 wheel_input 之后当兜底。
    const METHOD_CANDIDATES: [ScrollMethod; 5] = [
        ScrollMethod::WheelPost,
        ScrollMethod::WheelInput,
        ScrollMethod::WheelPostRoot,
        ScrollMethod::PageDown,
        ScrollMethod::VScroll,
    ];
    // 挨个试方式时的诊断记录（失败时报给用户 + 写日志）。没有它，「该区域没有发生滚动」
    // 这句话对用户和对开发者都是死胡同：既不知道试了哪些方式，也不知道画面到底动没动。
    let mut tried: Vec<String> = Vec::new();
    let mut max_try_diff = 0.0f32;
    let mut best_try_shift = 0u32;
    // 首轮全部候选都没让画面动时，是否已经用「每步 2 格」重试过一遍
    let mut retry_used = false;
    // 已经证实「对这个目标无效」的注入方式（试错失败画面不会动，所以排除它们零代价）
    let mut dead_methods: Vec<ScrollMethod> = Vec::new();
    let canvas_w = cap.w;
    let params = MatchParams::for_height(cap.h);

    // 画面到底动没动：**必须以测得出连贯位移为准**，不能只看像素差异
    // （页面自身的动画/闪烁也能让 diff 变大，那会把方式误锁成可用）。
    let has_moved = |a: &RgbaImage, b: &RgbaImage| -> bool {
        match_frames(a, b, &params, None)
            .filter(|mm| mm.shift >= MIN_SHIFT)
            .is_some()
            || tolerant_shift(a, b)
                .filter(|(_, ratio)| *ratio < 0.8 && est_err_ok(a, b))
                .is_some()
    };
    // 选区高度被补足过 → 给用户一句说明（**长图宽度仍然是选区宽度**，只是纵向多捕获一些
    // 以保证相邻帧有足够重叠区；这是「框一小块也能长截图」的关键）
    let padded = cap.h > rect.h;

    {
        let mut p = ScrollCaptureProgress::bare("capturing", &cap);
        p.method = method.map(|m| m.name().to_string());
        p.input_passthrough = method == Some(ScrollMethod::WheelInput);
        p.message = Some(if padded {
            format!(
                "选区较矮，已自动把捕获高度补到 {}px 以保证拼接（长图宽度不变）",
                cap.h
            )
        } else {
            "开始滚动并拼接…".to_string()
        });
        on_progress(p.with_capture(&cap));
    }

    // ---- 3. 起始帧 ----
    let first = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms)?;
    let mut canvas: Vec<u8> = Vec::with_capacity(
        cap.w as usize * cap.h as usize * 4 * 4,
    );
    let mut canvas_h = 0u32;
    // 首帧：整帧入画布（无重叠）
    append_band(&mut canvas, canvas_w, &mut canvas_h, &first.image, 0, 0, 0)?;
    dlog.log(&format!(
        "first frame {}x{} settle={}ms polls={} timed_out={} cap={}x{} notches={} method={:?}",
        first.image.width(),
        first.image.height(),
        first.elapsed_ms,
        first.polls,
        first.timed_out,
        cap.w,
        cap.h,
        notches,
        method.map(|m| m.name())
    ));
    let mut preview = PreviewBuilder::new(canvas_w, PREVIEW_WIDTH);
    preview.append_strip(&first.image, 0);

    let mut prev = first.image;
    let mut frames = 1u32;
    // 还不知道「一格滚多少像素」（方式也是主循环里才定），所以第一步不设先验位移
    let mut last_shift: Option<u32> = None;
    let mut last_bottom_fixed = 0u32;
    // 起始帧入画时还没有固定栏信息；首次成功注册后再把它的吸底栏剔除。
    let mut initial_footer_pending = true;
    let mut failures = 0u32;
    let mut low_conf = false;
    let mut stop_reason: Option<String> = None;
    // 是否见过「确实动了、但位移小于 MIN_SHIFT」的帧。这是「已经到底/只剩几像素」
    // 的**观测证据**，与「所有注入方式都无效」是两回事，退出时要分开处理（见下方 match 分支）。
    let mut bottom_reached = false;

    {
        let mut p = ScrollCaptureProgress::bare("capturing", &cap);
        p.frames = frames;
        p.height = canvas_h;
        p.method = method.map(|m| m.name().to_string());
        p.input_passthrough = method == Some(ScrollMethod::WheelInput);
        p.preview = preview.data_url(PREVIEW_MAX_H);
        on_progress(p.with_capture(&cap));
    }

    // ---- 4. 主循环 ----
    while stop_reason.is_none() {
        if cancel.load(Ordering::Relaxed) {
            stop_reason = Some("已停止".to_string());
            break;
        }
        if frames >= o.max_frames {
            stop_reason = Some(format!("达到帧数上限 {}，已保留当前结果", o.max_frames));
            break;
        }
        if canvas_h >= o.max_height_px {
            stop_reason = Some(format!("达到高度上限 {}px，已保留当前结果", o.max_height_px));
            break;
        }

        // 注入 + 稳定帧等待。**一律用补足后的捕获区**（`cap`）：选区宽度不变，
        // 但纵向留出了足够重叠区，矮选区也能拼。
        let frames_before = frames;
        // 方式未定时，按候选表挨个试；试错失败画面不会动，所以没有任何视觉代价
        let m = match method {
            Some(m) => m,
            None => {
                // 选下一个候选：跳过已知对本目标无效的方式；首轮全失败后把候选改用
                // 「每步 2 格」再试一遍 —— 1 格（40-50px）有可能小到指纹匹配测不出位移，
                // 看起来就像「根本没滚」。
                let mut pick: Vec<ScrollMethod> = METHOD_CANDIDATES
                    .into_iter()
                    .filter(|c| !dead_methods.contains(c))
                    .collect();
                if pick.is_empty() && !retry_used && o.notches.is_none() && !bottom_reached {
                    retry_used = true;
                    notches = notches.max(2);
                    pick = METHOD_CANDIDATES.to_vec();
                    tracing::info!("滚动截图: 全部候选未动，改用每步 {notches} 格重试一遍");
                }
                // 已经观测到「确实滚了、但位移 < MIN_SHIFT」（典型：启动时就在页面底部）：
                // 这时**不能**把候选表耗尽当成失败，否则「在底部开始」会被误报成「不可滚动」。
                // 直接按「到底」收尾，保留首帧内容，由下面「只截到一帧」的判定决定是
                // 正常结束（本来就只有一屏）还是报错。
                if pick.is_empty() && bottom_reached {
                    dlog.log("  位移过小且候选已试完 -> 判定已到底");
                    stop_reason = Some("已到达内容底部（滚动位移小于最小阈值）".to_string());
                    break;
                }
                let m = if pick.is_empty() {
                    // 所有注入方式都没能让画面产生可信位移。把「试过什么、画面到底动没动」
                    // 一并报出来：否则用户只能看到一句无从下手的「没有发生滚动」。
                    let deepest = deepest_child_at(cx, cy);
                    let deep_note = match deepest {
                        Some(h) if root_window(h) == root => {
                            "选区内最深的目标就是目标窗口本身".to_string()
                        }
                        Some(h) => format!(
                            "选区内最深的目标是 0x{h:X}（{}），滚轮消息发给了它",
                            window_info(hwnd_from(h))
                                .map(|w| format!("{} / {}", w.class, w.title))
                                .unwrap_or_else(|| "无法读取窗口信息".to_string())
                        ),
                        None => "选区内没找到目标窗口".to_string(),
                    };
                    let movement = if max_try_diff > SCROLLED_DIFF_RATIO {
                        format!(
                            "试的过程中画面确实在变（最大像素差异 {:.1}%）、但测不出可信的整体位移 —— \
                             典型的「亚像素滚动 / 周期性重绘 / 选区里在放视频动画」。",
                            max_try_diff * 100.0
                        )
                    } else if best_try_shift > 0 {
                        format!(
                            "测到的最大位移只有 {best_try_shift}px，小于 {MIN_SHIFT}px 的下限，\
                             可能是一次滚动幅度太小。"
                        )
                    } else {
                        "试的过程中画面完全没有变化。".to_string()
                    };
                    return Err(format!(
                        "该区域没有发生滚动（捕获区 {}×{}，选区 {}×{}）。\
                         已依次尝试：{}。{deep_note}。{movement}\
                         请确认：① 这块区域本身可以滚动（不是视频/固定布局）；\
                         ② 选区没有跨越两个滚动区域；③ 选区不要压在窗口标题栏/固定页头这类不滚动的地方。",
                        cap.w,
                        cap.h,
                        rect.w,
                        rect.h,
                        tried.join(" → "),
                    ));
                } else {
                    pick.remove(0)
                };
                m
            }
        };
        if method.is_none() {
            // 试 WheelInput 时覆盖窗要临时放行鼠标，否则滚轮会被我们自己的窗吃掉
            host.set_passthrough(m == ScrollMethod::WheelInput);
        }
        let injected = with_cursor_at(&cap, m, || inject_scroll(root, &cap, m, notches));
        if let Err(e) = injected {
            tried.push(format!("{}（注入失败：{e}）", m.name()));
            dead_methods.push(m);
            continue;
        }
        // 若等到超时还没稳定（Chrome 平滑滚动距离一长就要 1.5s+），别拿动画中间帧去匹配
        // ——那必然匹配失败。再给最多两轮机会。
        // 采帧期间（且仅当 HUD 压在捕获区上时）通知前端把 HUD 让开。
        hud_overlap_live = hud_overlap.map(|f| f.load(Ordering::Relaxed)).unwrap_or(false);
        frame_gate.borrow_mut().set_enabled(hud_overlap_live);
        frame_gate.borrow_mut().begin_frame();
        let settled = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms);
        frame_gate.borrow_mut().end_frame();
        let mut settled = settled?;
        let mut retries = 0;
        while settled.timed_out && retries < 2 {
            retries += 1;
            tracing::info!(
                "滚动截图: 帧{} 稳定等待超时（{}ms），再等一轮",
                frames,
                settled.elapsed_ms
            );
            frame_gate.borrow_mut().begin_frame();
            settled = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms)?;
            frame_gate.borrow_mut().end_frame();
        }
        let mut cur = settled.image;
        let diff = frame_diff_ratio(&prev, &cur);
        dlog.log(&format!(
            "frame{frames} inject={} notches={notches} settle={}ms timed_out={} diff={diff:.5} canvas_h={canvas_h}",
            m.name(),
            settled.elapsed_ms,
            settled.timed_out
        ));

        // ---- 方式还没定：用「这次到底动没动」来判定 ----
        // 注意：这里**不能**先做「两帧一致 = 到底」的判定 —— 还没滚起来时画面当然一致，
        // 会被误判成「已经到底」而直接结束。
        // 方式未定时，判定「这次到底动没动」**必须以「测得出连贯位移」为准**，
        // 不能只看像素差异：页面自身的动画/闪烁也能让 diff 变大（那会把方式误锁成可用，
        // 之后每一帧都匹配失败 → 一帧都拼不上，报「没有捕获到可拼接的内容」）。
        if method.is_none() {
            if !has_moved(&prev, &cur) {
                max_try_diff = max_try_diff.max(diff);
                if let Some(s) = tolerant_shift(&prev, &cur)
                    .filter(|(_, ratio)| *ratio < 0.8 && est_err_ok(&prev, &cur))
                    .map(|(s, _)| s)
                {
                    best_try_shift = best_try_shift.max(s);
                }
                dead_methods.push(m);
                tried.push(format!("{}（差异 {:.1}%）", m.name(), diff * 100.0));
                tracing::info!(
                    "滚动截图: 方式 {} 无效（diff={:.4}），换下一个",
                    m.name(),
                    diff
                );
                prev = cur;
                continue;
            }
            // 定下来了：这一次注入本身就是**第一帧真实内容**，不浪费
            method = Some(m);
            if wheel_like(m) {
                // 顺手标定「一格滚多少像素」，用于后续每步的格数（这一步只用了 1 格）
                if let Some(mm) = match_frames(&prev, &cur, &params, None).filter(|mm| mm.shift >= MIN_SHIFT) {
                    let usable_h = cap
                        .h
                        .saturating_sub(mm.top_fixed)
                        .saturating_sub(mm.bottom_fixed);
                    if mm.shift + params.min_overlap >= usable_h {
                        return Err(format!(
                            "选区太矮：一次滚动约 {}px，扣除 {}px 固定区域后正文只有 {}px，\
                             不足以保留 {}px 的最小重叠区，无法拼接。\
                             请把选区拉高到 {}px 以上，或在更大的窗口里重新框选。",
                            mm.shift,
                            mm.top_fixed + mm.bottom_fixed,
                            usable_h,
                            params.min_overlap,
                            mm.shift + mm.top_fixed + mm.bottom_fixed + params.min_overlap + 16
                        ));
                    }
                    if o.notches.is_none() {
                        let target = (cap.h as f32 * 0.4) as u32;
                        notches = (target / mm.shift.max(1)).clamp(1, 40);
                        // 标定把「每步位移」从 1 格放大到 notches 格，`last_shift` 是**旧尺度**的
                        // 先验。`match_frames` 只在 [prior/4, prior*4] 里找候选，尺度一变就可能
                        // 把所有正确候选都筛掉、退回保守的 peak 位移，于是每步少追加一大截
                        // （帧数暴涨、还容易触发「高度上限」提前收兵）。所以标定后清掉先验，
                        // 让下一帧重新自由匹配一次。
                        last_shift = None;
                    }
                }
            }
            tracing::info!(
                "滚动截图: 注入方式={}（主循环试出）每步={}格 捕获区={}x{}（选区 {}x{}）",
                m.name(),
                notches,
                cap.w,
                cap.h,
                rect.w,
                rect.h
            );
            let mut p = ScrollCaptureProgress::bare("capturing", &cap);
            p.frames = frames;
            p.height = canvas_h;
            p.method = Some(m.name().to_string());
            p.input_passthrough = m == ScrollMethod::WheelInput;
            p.message = Some(format!("注入方式 {}（每步 {notches} 格）", m.name()));
            p.preview = preview.data_url(PREVIEW_MAX_H);
            on_progress(p.with_capture(&cap));
        }

        // 与上一帧完全一致 → 再等一轮确认，仍一致就是到底了
        if diff <= SAME_FRAME_RATIO {
            std::thread::sleep(Duration::from_millis(o.settle_timeout_ms.min(1200)));
            let again = settle_capture(&cap, o.settle_timeout_ms, o.poll_ms)?.image;
            if frame_diff_ratio(&cur, &again) <= SAME_FRAME_RATIO {
                tracing::info!("滚动截图: 帧{frames} 画面不再变化 → 判定到底");
                break; // 正常到底
            }
            cur = again;
        }

        let matched = match_frames(&prev, &cur, &params, last_shift);
        tracing::info!(
            "滚动截图: 帧{} diff={:.4} 匹配={:?}",
            frames,
            diff,
            matched.map(|m| (m.shift, m.run, m.top_fixed, m.bottom_fixed, m.ambiguous))
        );
        dlog.log(&format!(
            "  match={:?} min_overlap={} last_shift={:?} failures={failures}",
            matched.map(|m| (
                m.shift,
                m.run,
                m.top_fixed,
                m.bottom_fixed,
                m.ambiguous,
                m.runner_up,
                m.block_inlier_ratio,
                m.mean_block_error,
                m.runner_up_gap,
            )),
            params.min_overlap,
            last_shift
        ));
        match matched {
            Some(m) if m.shift >= MIN_SHIFT => {
                if initial_footer_pending {
                    if trim_initial_footer(&mut canvas, canvas_w, &mut canvas_h, m.bottom_fixed) {
                        // 预览也必须和画布保持同一不变量，否则结果虽正确、缩略图却仍会在
                        // 中间显示一次首帧页脚。
                        if let Some(body) = RgbaImage::from_raw(canvas_w, canvas_h, canvas.clone()) {
                            preview = PreviewBuilder::new(canvas_w, PREVIEW_WIDTH);
                            preview.append_strip(&body, 0);
                        }
                        dlog.log(&format!(
                            "  首帧吸底栏 {}px 已剔除，canvas_h={canvas_h}",
                            m.bottom_fixed
                        ));
                    }
                    initial_footer_pending = false;
                }
                // 本帧正文里的新内容：正文区最后 shift 行（画布只存 页头+正文，见 append_band）
                let body_h = cur
                    .height()
                    .saturating_sub(m.top_fixed)
                    .saturating_sub(m.bottom_fixed);
                let append_from = body_h.saturating_sub(m.shift) + m.top_fixed;
                let net = cur.height().saturating_sub(m.bottom_fixed).saturating_sub(append_from);
                let new_h = canvas_h + net;
                // 内容重复率仅用于诊断：白底、段落留白、表格行等都会让它很高，不能再
                // 把它当成拼接正确性的证据或结果置信度。
                let dup = duplicate_ratio(&canvas, canvas_w, canvas_h, &cur, append_from, cur.height().saturating_sub(m.bottom_fixed));
                dlog.log(&format!(
                    "  append? shift={} header={} footer={} append_from={append_from} net={net} new_h={new_h} duplicate_diagnostic={dup:.3} support={:.3} error={:.2} gap={:.3} canvas_h={canvas_h}",
                    m.shift, m.top_fixed, m.bottom_fixed, m.block_inlier_ratio, m.mean_block_error, m.runner_up_gap
                ));
                let overlap = cur.height().saturating_sub(m.shift);
                let weak = m.ambiguous
                    || (m.run as u64) * 2 < overlap as u64
                    || m.block_inlier_ratio < 0.75
                    || m.mean_block_error > 12.0
                    || (m.runner_up.is_some() && m.runner_up_gap < 0.08);
                if new_h as u64 * canvas_w as u64 * 4 > MAX_CANVAS_BYTES {
                    stop_reason = Some("结果过大（内存上限），已保留当前结果".to_string());
                } else {
                    if dup > 0.6 {
                        tracing::info!(
                            "滚动截图: 帧{} 内容重复诊断 {:.0}%（不影响配准置信度；support={:.0}% error={:.1} gap={:.0}%）",
                            frames,
                            dup * 100.0,
                            m.block_inlier_ratio * 100.0,
                            m.mean_block_error,
                            m.runner_up_gap * 100.0,
                        );
                    }
                    append_band(&mut canvas, canvas_w, &mut canvas_h, &cur, m.top_fixed, m.bottom_fixed, m.shift)?;
                    let strip = image::imageops::crop_imm(&cur, 0, append_from, canvas_w, net).to_image();
                    preview.append_strip(&strip, canvas_h - net);
                    frames += 1;
                    last_shift = Some(m.shift);
                    last_bottom_fixed = m.bottom_fixed;
                    failures = 0;
                    if weak {
                        low_conf = true;
                    }
                    dlog.log(&format!(
                        "  -> 追加成功 frames={frames} canvas_h={canvas_h} 净增={net} low_conf={low_conf}"
                    ));
                }
            }
            Some(mm) if mm.shift > 0 => {
                // 位移太小（但确实动了）：可能是「到底了」，也可能是**当前这种注入方式对这个
                // 目标突然失效**（典型：页面里先滚外层、再滚到内层侧栏，或者切了路由/换了滚动
                // 容器）。早期直接 break 当作正常到底，于是用户看到「滚动截图完成」却只截到一屏。
                // 现在改成：只要还有没试过的注入方式，就退回「挨个试」再找一种。
                bottom_reached = true;
                let has_untried = METHOD_CANDIDATES.iter().any(|c| !dead_methods.contains(c));
                if has_untried {
                    tracing::info!(
                        "滚动截图: 帧{frames} 位移过小（{}px），换一种注入方式再试（当前 {}）",
                        mm.shift,
                        m.name()
                    );
                    dlog.log(&format!("  shift {} < MIN_SHIFT -> 换注入方式重探测", mm.shift));
                    dead_methods.push(m);
                    method = None;
                    last_shift = None;
                    prev = cur;
                    continue;
                }
                // ⚠ 候选**全部试完**时不能再把那句「该区域没有发生滚动」当成结论：这里明明
                // 观测到了滚动（只是幅度小于 MIN_SHIFT），最常见的成因就是已经在页面底部。
                // 早期实现会在下一次循环走进「候选为空 → return Err(...没有发生滚动...)」，
                // 于是「在底部启动」被误报成「这块区域不可滚动」（用户侧看起来像功能坏了）。
                break;
            }
            Some(_) => {
                // 位移为 0：怎么滚都不动，就是到底了
                break;
            }
            None => {
                // 匹配失败。两种可能：
                // (a) 这个目标的渲染不是像素级可复现（亚像素滚动重绘、文字抗锯齿抖动）
                //     → 用容差 SAD 兜底拼上，标记低置信；
                // (b) 真的拼不上（动画、画面跳变）→ 用上一步位移当 best-guess 继续；
                //     连续失败多次就收兵，保留已拼接部分。
                let tolerant = tolerant_shift(&prev, &cur)
                    .filter(|(_, ratio)| *ratio < 0.8 && est_err_ok(&prev, &cur));
                if let Some((shift, _ratio)) = tolerant {
                    // 下标换算必须与 `append_band` 的约定一致（画布只存 页头+正文，
                    // 吸底栏由收尾贴一次）：本帧正文里最新的是 shift 行、且位于吸底栏**之上**，
                    // 所以追加区结束于 `h - last_bottom_fixed`，起点是 `h - last_bottom_fixed - shift`。
                    // ⚠ 早期这里写成 `h - shift`（把吸底栏也算进新内容），于是预览条带比画布实际
                    // 追加的内容**偏移了一个页脚高度**（缩略图与长图对不上）。
                    let footer_h = last_bottom_fixed.min(cur.height().saturating_sub(1));
                    let shift = shift.min(cur.height().saturating_sub(footer_h).saturating_sub(1));
                    let append_from = cur.height().saturating_sub(footer_h).saturating_sub(shift);
                    let net = cur.height().saturating_sub(footer_h) - append_from;
                    let _ = append_band(&mut canvas, canvas_w, &mut canvas_h, &cur, 0, footer_h, shift);
                    if net > 0 {
                        let strip = image::imageops::crop_imm(&cur, 0, append_from, canvas_w, net).to_image();
                        preview.append_strip(&strip, canvas_h - net);
                    }
                    frames += 1;
                    last_shift = Some(shift);
                    failures = 0;
                    low_conf = true;
                } else {
                    failures += 1;
                    low_conf = true;
                    if let Some(guess) = last_shift.filter(|g| *g >= MIN_SHIFT && *g < cur.height()) {
                        let _ = append_band(&mut canvas, canvas_w, &mut canvas_h, &cur, 0, last_bottom_fixed, guess);
                        frames += 1;
                    }
                    if failures >= MAX_MATCH_FAILURES {
                        stop_reason = Some(
                            "连续多帧无法匹配（内容可能有动画或大面积重复），已保留当前结果"
                                .to_string(),
                        );
                    }
                }
            }
        }

        prev = cur;

        // 进度事件（含缩略预览）。本帧没追加成功时不要报「匹配成功」，
        // 否则前端会看到一串「帧数不变」的进度、以为卡住了。
        let progressed = frames > frames_before;
        let mut p = ScrollCaptureProgress::bare(if progressed { "matched" } else { "capturing" }, &cap);
        p.frames = frames;
        p.height = canvas_h;
        p.width = canvas_w;
        p.method = method.map(|m| m.name().to_string());
        p.input_passthrough = method == Some(ScrollMethod::WheelInput);
        if low_conf {
            p.stage = "low_confidence".to_string();
            p.message = Some("部分帧的位移配准证据不足（可能有动画、固定控件或重复布局）".to_string());
        }
        p.preview = preview.data_url(PREVIEW_MAX_H);
        on_progress(p.with_capture(&cap));
        // 任务栏进度：全屏/整窗选区时覆盖窗里没空地放 HUD，这里是唯一始终可见的反馈
        host.set_progress(true, canvas_h as f32 / o.max_height_px.max(1) as f32);

        if let Some(reason) = stop_reason.clone() {
            let _ = reason;
            break;
        }
    }

    // 正常收尾：立刻还原宿主（幂等；即使这里不写，`session_cleanup` 的 Drop 也会兜底）
    session_cleanup.host.set_escape_hook(false);
    session_cleanup.host.set_passthrough(false);
    // 结束时清掉任务栏进度（成功/失败/取消都要走到这里）
    session_cleanup.host.set_progress(false, 0.0);
    // 会话结束：任何路径都不能把前端 HUD 留在「采帧隐藏」态
    session_cleanup.gate.borrow_mut().restore();

    // ---- 5. 收尾 ----
    // 画布只存「页头 + 累积正文」（见 append_band 的约定），这里把最后一帧的吸底栏贴上，
    // 于是它整张长图只出现一次。
    attach_footer(&mut canvas, canvas_w, &mut canvas_h, &prev, last_bottom_fixed);
    if canvas_h <= cap.h.saturating_sub(last_bottom_fixed) {
        // 只截到一帧：说明根本没滚动起来（画布只含 页头+正文，所以拿「一帧的正文高」比）
        dlog.log(&format!(
            "FAIL 只有一帧 canvas_h={canvas_h} cap.h={} footer={last_bottom_fixed} frames={frames} tried={tried:?} dead={:?}",
            cap.h,
            dead_methods.iter().map(|m| m.name()).collect::<Vec<_>>()
        ));
        return Err("没有捕获到可拼接的内容（目标区域可能不可滚动）".to_string());
    }
    let img = RgbaImage::from_raw(canvas_w, canvas_h, canvas)
        .ok_or_else(|| "拼接缓冲区尺寸不一致".to_string())?;
    let png = encode_png(&img, false)?;

    let confidence = if stop_reason.is_some() {
        "partial"
    } else if low_conf {
        "low"
    } else {
        "high"
    };

    let result = ScrollCaptureResult {
        width: canvas_w,
        height: canvas_h,
        frames,
        confidence: confidence.to_string(),
        message: stop_reason.clone(),
        png,
    };

    let mut p = ScrollCaptureProgress::bare(
        if result.confidence == "partial" { "partial" } else { "done" },
        &rect,
    );
    dlog.log(&format!(
        "OK {}x{} frames={frames} confidence={confidence} method={:?} notches={notches} stop={:?}",
        result.width,
        result.height,
        method.map(|m| m.name()),
        result.message
    ));
    p.frames = result.frames;
    p.width = result.width;
    p.height = result.height;
    p.method = method.map(|m| m.name().to_string());
    p.input_passthrough = false;
    p.message = result.message.clone();
    p.preview = preview.data_url(PREVIEW_MAX_H);
    on_progress(p.with_capture(&cap));

    Ok(result)
}

/// 会话期间把光标钉在选区外，结束后还原（避免悬停高亮污染帧 + 不打扰用户）
struct CursorGuard {
    had: bool,
    pos: POINT,
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

/// 预览缩略图宽度（物理像素）
const PREVIEW_WIDTH: u32 = 120;
/// 预览缩略图最大高度（超出就整体压扁）
const PREVIEW_MAX_H: u32 = 360;
/// 拼接缓冲区内存上限（RGBA 字节数）
const MAX_CANVAS_BYTES: u64 = 768 * 1024 * 1024;

// ============================================================
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
}

impl TauriHost {
    fn screenshot_window(&self) -> Option<tauri::WebviewWindow> {
        use tauri::Manager;
        self.app.get_webview_window("screenshot")
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
                    use tauri::Manager;
                    if let Some(state) = app.try_state::<ScrollCaptureSession>() {
                        state.cancel();
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
}

/// 开始滚动截图（异步跑在工作线程；进度与结果走事件）
#[tauri::command]
pub fn start_scroll_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, ScrollCaptureSession>,
    req: ScrollCaptureRequest,
) -> Result<(), String> {
    let options = SessionOptions::from_request(&req)?;
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

    let app2 = app.clone();
    tracing::info!(
        "滚动截图: 开始 {}x{} @ ({},{}) 方式={:?}",
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
        };
        let result = {
            let mut emit = |p: ScrollCaptureProgress| {
                if let Some(state) = app2.try_state::<ScrollCaptureSession>() {
                    state.set_progress(p.clone());
                }
                if let Err(e) = app2.emit("scroll-capture-progress", p) {
                    tracing::warn!("emit scroll-capture-progress 失败: {e}");
                }
            };
            // 采帧瞬间让 HUD 让开（前端收到后给 HUD 加 .hud-hidden，抓完再撤掉）
            let app3 = app2.clone();
            let on_frame = move |hiding: bool| {
                if let Err(e) = app3.emit("scroll-capture-hud", serde_json::json!({ "hidden": hiding })) {
                    tracing::warn!("emit scroll-capture-hud 失败: {e}");
                }
            };
            run_session_ext(
                &req,
                &options,
                &host,
                &cancel,
                Some(&hud_overlap),
                Some(Box::new(on_frame)),
                &mut emit,
            )
        };

        // 收尾：无论如何都要把覆盖窗的 click-through / 全局 Esc / 截图互斥恢复
        host.set_passthrough(false);
        host.set_escape_hook(false);
        if let Some(store) = app2.try_state::<crate::screenshot::ScreenshotStore>() {
            store.end_capture();
        }

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
/// 后端会在每次采帧的前后发 `scroll-capture-hud` 事件让前端临时隐藏 HUD ——
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
                let _ = app.emit(
                    "open-image",
                    serde_json::json!({ "path": saved_path }),
                );
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

// ============================================================
// 单元测试（无需真实屏幕：只测与 Win32 无关的纯逻辑）
// ============================================================


#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn rect_inset_and_center() {        let r = RectPx {
            x: 100,
            y: 200,
            w: 400,
            h: 300,
        };
        assert_eq!(r.center(), (300, 350));
        assert_eq!(r.right(), 500);
        assert_eq!(r.bottom(), 500);
        let i = r.inset(10);
        assert_eq!((i.x, i.y, i.w, i.h), (110, 210, 380, 280));
        // 内缩超过一半时不能出现 0/负尺寸
        let j = r.inset(1000);
        assert!(j.w >= 1 && j.h >= 1);
    }

    #[test]
    fn lparam_packing() {
        // 低 16 位 x、高 16 位 y，负数按补码截断
        assert_eq!(make_lparam(0x1234, 0x5678), 0x5678_1234);
        assert_eq!(make_lparam(-1, -1) as u32 as u64 & 0xFFFF_FFFF, 0xFFFF_FFFF);
    }

    #[test]
    fn shift_estimate_on_synthetic_scroll() {
        // 造一张有纵向纹理的图，整体上移 37px 后应能被估计出来
        let (w, h) = (200u32, 400u32);
        let mut prev = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = ((y * 7 + x * 3) % 251) as u8;
                prev.put_pixel(x, y, image::Rgba([v, v, v, 255]));
            }
        }
        let mut cur = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let src_y = y + 37;
                let v = if src_y < h {
                    *prev.get_pixel(x, src_y)
                } else {
                    image::Rgba([0, 0, 0, 255])
                };
                cur.put_pixel(x, y, v);
            }
        }
        let est = estimate_shift(&prev, &cur).expect("应有估计结果");
        assert_eq!(est.shift, 37, "位移估计错误: {:?}", est);
        assert!(est.err < 0.5, "误差应接近 0: {:?}", est);
        assert!(est.improvement() > 100.0, "应明显优于不滚动: {:?}", est);
    }

    #[test]
    fn frame_diff_detects_change() {
        let a = RgbaImage::from_pixel(64, 64, image::Rgba([10, 10, 10, 255]));
        let mut b = a.clone();
        assert_eq!(frame_diff_ratio(&a, &b), 0.0);
        // 改一半像素
        for y in 0..32 {
            for x in 0..64 {
                b.put_pixel(x, y, image::Rgba([200, 200, 200, 255]));
            }
        }
        let r = frame_diff_ratio(&a, &b);
        assert!((r - 0.5).abs() < 0.05, "差异占比应约 0.5，实际 {r}");
    }

    // ---------- 拼接匹配 ----------

    /// 造「每行都不同」的噪声纹理（真实网页的内容虽更平滑，但对行指纹来说等价：
    /// 关键是每一行可区分）。
    ///
    /// 用 xorshift 逐行生成：**不能**用 `y*a + x*b + seed*c` 这种线性式——它的低位
    /// 在 mod 256 下会让不同 seed 的图恰好相差整数行（第一版测试就踩了这个坑：
    /// 「无关」的两张图其实是彼此的 10px 位移，匹配器判对了、测试写错了）。
    fn noise(w: u32, h: u32, seed: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            let mut s = seed
                .wrapping_mul(0x9E37_79B9)
                .wrapping_add(y.wrapping_mul(0x85EB_CA6B))
                | 1;
            for x in 0..w {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                let v = (s >> 8) as u8;
                img.put_pixel(x, y, image::Rgba([v, v.wrapping_add(37), v.wrapping_mul(3), 255]));
            }
        }
        img
    }

    /// 把 `content` 的第 `row` 行写进 `img`（用于拼装带吸顶/吸底的帧）
    fn paste_row(img: &mut RgbaImage, y: u32, src: &RgbaImage, src_row: u32) {
        for x in 0..img.width() {
            img.put_pixel(x, y, *src.get_pixel(x, src_row));
        }
    }

    /// 生成一对「内容整体上移 s、带 40 行吸顶、带 30 行吸底」的帧
    fn make_pair(w: u32, h: u32, s: u32, sticky_top: u32, fixed_bottom: u32) -> (RgbaImage, RgbaImage) {
        let header = noise(w, sticky_top.max(1), 11);
        let footer = noise(w, fixed_bottom.max(1), 22);
        let content = noise(w, h + s + 8, 33);
        let mut prev = RgbaImage::new(w, h);
        let mut cur = RgbaImage::new(w, h);
        for y in 0..h {
            if y < sticky_top {
                paste_row(&mut prev, y, &header, y);
                paste_row(&mut cur, y, &header, y);
            } else if y >= h - fixed_bottom {
                let fr = y - (h - fixed_bottom);
                paste_row(&mut prev, y, &footer, fr);
                paste_row(&mut cur, y, &footer, fr);
            } else {
                let cy = y - sticky_top;
                paste_row(&mut prev, y, &content, cy);
                paste_row(&mut cur, y, &content, cy + s);
            }
        }
        (prev, cur)
    }

    #[test]
    fn match_finds_plain_shift() {
        let (prev, cur) = make_pair(400, 600, 137, 0, 0);
        let m = match_frames(&prev, &cur, &MatchParams::for_height(600), None).expect("应匹配成功");
        assert_eq!(m.shift, 137, "位移识别错误: {m:?}");
        assert!(!m.ambiguous, "纯噪声纹理不该被判歧义: {m:?}");
        assert!(m.run > 300, "重叠区应很长: {m:?}");
    }

    #[test]
    fn match_ignores_sticky_header_and_fixed_footer() {
        let (prev, cur) = make_pair(400, 600, 100, 40, 30);
        let m = match_frames(&prev, &cur, &MatchParams::for_height(600), None).expect("应匹配成功");
        assert_eq!(m.shift, 100, "位移识别错误: {m:?}");
        assert_eq!(m.top_fixed, 40, "吸顶带高度识别错误: {m:?}");
        assert_eq!(m.bottom_fixed, 30, "吸底带高度识别错误: {m:?}");
        assert!(m.block_inlier_ratio > 0.95, "正确位移应得到高支持率: {m:?}");
        assert!(m.mean_block_error < 0.1, "正确位移应几乎没有残差: {m:?}");
    }

    #[test]
    fn match_rejects_unrelated_frames() {
        // 两帧内容完全无关（页面跳转/切换到别的标签）→ 必须拒绝，而不是乱拼
        let a = noise(400, 600, 1);
        let b = noise(400, 600, 999);
        let m = match_frames(&a, &b, &MatchParams::for_height(600), None);
        assert!(m.is_none(), "无关帧不应该匹配成功: {m:?}");
    }

    #[test]
    fn prior_shift_resolves_periodic_ambiguity() {
        // 周期性内容（每 25 行重复一次）：位移 300 与 275/250… 都能对上，
        // 这时必须靠「上一步位移」这个先验挑正确的那个（P0 实测的坑）
        let w = 300u32;
        let h = 800u32;
        let period = 25u32;
        let shift_true = 300u32;
        let tile = noise(w, period, 7);
        let mut prev = RgbaImage::new(w, h);
        let mut cur = RgbaImage::new(w, h);
        for y in 0..h {
            paste_row(&mut prev, y, &tile, y % period);
            paste_row(&mut cur, y, &tile, (y + shift_true) % period);
        }
        // 无先验：周期性内容下只能保守取最小可行位移（会少追加，但不会重复内容）
        let m0 = match_frames(&prev, &cur, &MatchParams::for_height(h), None).expect("应匹配成功");
        assert!(m0.ambiguous, "周期性内容应被判为歧义: {m0:?}");
        assert_ne!(m0.shift, shift_true, "无先验时本来就不该猜对: {m0:?}");
        // 有先验：应精确命中 300
        let m1 = match_frames(&prev, &cur, &MatchParams::for_height(h), Some(shift_true))
            .expect("应匹配成功");
        assert_eq!(m1.shift, shift_true, "带先验应命中真实位移: {m1:?}");
    }

    #[test]
    fn match_tolerates_static_sidebar() {
        // 真实应用的普遍形态：左侧一块**不随滚动移动**的区域（资源管理器导航窗格、
        // VS Code 侧栏、网页固定侧栏）。整行单一指纹会因为这块静止区而全军覆没，
        // 分段多数表决必须能扛住。
        let w = 600u32;
        let h = 500u32;
        let shift = 90u32;
        let sidebar_w = 150u32; // 左侧 25% 静止
        let content = noise(w, h + shift + 8, 41);
        let sidebar = noise(sidebar_w, h, 42);
        let mut prev = RgbaImage::new(w, h);
        let mut cur = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if x < sidebar_w {
                    *sidebar.get_pixel(x, y)
                } else {
                    *content.get_pixel(x, y)
                };
                prev.put_pixel(x, y, v);
                let v2 = if x < sidebar_w {
                    *sidebar.get_pixel(x, y)
                } else {
                    *content.get_pixel(x, y + shift)
                };
                cur.put_pixel(x, y, v2);
            }
        }
        let m = match_frames(&prev, &cur, &MatchParams::for_height(h), None)
            .expect("带固定侧栏的帧也应该能匹配");
        assert_eq!(m.shift, shift, "位移识别错误: {m:?}");
    }

    #[test]
    fn match_rejects_row_multiple_shift_on_repetitive_rows() {
        // 等距同款列表（ListBox / 资源管理器图标网格的典型形态）：
        // 每行 20px，行内大部分是**完全相同的模板**（图标/空白），只有一小块行号不同。
        // 这种情况下「连续滚了 3 行 = 60px」绝不能被认成「滚了 1 行 = 20px」——
        // 否则每步只前进 1/3 的内容，拼出来的长图会大量漏内容。
        let (w, h, row_h, shift) = (400u32, 400u32, 20u32, 60u32);
        let template = noise(w, row_h, 71);
        let build = |first_row: u32| {
            let mut img = RgbaImage::new(w, h);
            for y in 0..h {
                let row = first_row + y / row_h;
                for x in 0..w {
                    // 模板部分：所有行完全一样
                    let mut px = *template.get_pixel(x, y % row_h);
                    // 行号部分：x∈[180,240) 处放一个随行号变化的图案（真实行内容的替身）
                    if (180..240).contains(&x) {
                        let v = (row.wrapping_mul(37).wrapping_add(x / 4)) as u8;
                        px = image::Rgba([v, v.wrapping_mul(3), v.wrapping_add(11), 255]);
                    }
                    img.put_pixel(x, y, px);
                }
            }
            img
        };
        let prev = build(0);
        let cur = build(shift / row_h); // 内容上移 3 行
        let m = match_frames(&prev, &cur, &MatchParams::for_height(h), None)
            .expect("应匹配成功");
        assert_eq!(m.shift, shift, "把 3 行认成了别的行数: {m:?}");
    }

    #[test]
    fn duplicate_gate_flags_repeated_append() {
        // 画布 100 行；把「完全相同的 40 行」再追加一次 → 应判为重复（位移估小的典型症状）
        let (w, h) = (64u32, 100u32);
        let canvas_img = noise(w, h, 3);
        let canvas = canvas_img.as_raw().clone();
        // 追加带 = 画布尾部 40 行（内容已在图里）
        let band = image::imageops::crop_imm(&canvas_img, 0, h - 40, w, 40).to_image();
        let dup = duplicate_ratio(&canvas, w, h, &band, 0, band.height());
        assert!(dup > 0.9, "重复内容应被识别，实际重复率 {dup}");

        // 正常情况：全新内容 → 重复率应接近 0
        let fresh = noise(w, 40, 99);
        let dup2 = duplicate_ratio(&canvas, w, h, &fresh, 0, fresh.height());
        assert!(dup2 < 0.2, "全新内容不该被判重复，实际 {dup2}");

        // 吸底栏那几行必须被排除在查重之外（band_end 只到正文结束）——否则每步都误判
        let mut with_footer = RgbaImage::new(w, 60);
        image::imageops::overlay(&mut with_footer, &fresh, 0, 0);
        let footer = image::imageops::crop_imm(&canvas_img, 0, h - 20, w, 20).to_image();
        image::imageops::overlay(&mut with_footer, &footer, 0, 40);
        let dup3 = duplicate_ratio(&canvas, w, h, &with_footer, 0, 40);
        assert!(dup3 < 0.2, "吸底栏不该被算成重复，实际 {dup3}");
    }

    /// 端到端验证「重叠 + 追加」的算术：合成一张唯一行的页面，按固定页头/页脚切帧，
    /// 走完 append_band 之后画布必须**逐像素等于**期望长图（无重复段、无漏段、页头页脚各一次）。
    ///
    /// 这个测试存在的理由：早期 `append_y = h - bottom_fixed - shift` 的错误公式让每步
    /// 净增只有 `shift - bottom_fixed`，页脚一大净增就≈0，画布永远超不过一帧 —— 表现就是
    /// 「只拼进 1 帧」，最后报「没有捕获到可拼接的内容」。光看代码很难发现，算式必须被断言。
    #[test]
    fn stitch_reproduces_expected_long_image() {
        const W: u32 = 16;
        const H: u32 = 300;
        const HEADER: u32 = 40;
        const FOOTER: u32 = 30;
        const BODY: u32 = H - HEADER - FOOTER;
        const PAGE_H: u32 = 1200;

        // 页面：每行唯一颜色（蓝色通道 = 行号 % 256，绿色通道区分高字节，避免绕回）
        let page = RgbaImage::from_fn(W, PAGE_H, |_x, y| {
            Rgba([(y % 256) as u8, (y / 256) as u8, 77, 255])
        });
        let header = RgbaImage::from_fn(W, HEADER, |_x, y| Rgba([200, 10, y as u8, 255]));
        let footer = RgbaImage::from_fn(W, FOOTER, |_x, y| Rgba([20, 200, y as u8, 255]));

        // 取一帧：吸顶页头 + 正文[scrollY, scrollY+BODY) + 吸底页脚
        let frame = |scroll_y: u32| -> RgbaImage {
            let mut f = RgbaImage::new(W, H);
            image::imageops::overlay(&mut f, &header, 0, 0);
            let body = image::imageops::crop_imm(&page, 0, scroll_y, W, BODY).to_image();
            image::imageops::overlay(&mut f, &body, 0, HEADER as i64);
            image::imageops::overlay(&mut f, &footer, 0, (H - FOOTER) as i64);
            f
        };

        // 每步位移必须小于视口正文高（否则不是「滚动」而是整屏跳）
        let step = 150u32;
        let steps = 4u32;
        let covered_body = (BODY + steps * step).min(PAGE_H);
        let mut expected = RgbaImage::new(W, HEADER + covered_body + FOOTER);
        image::imageops::overlay(&mut expected, &header, 0, 0);
        let body = image::imageops::crop_imm(&page, 0, 0, W, covered_body).to_image();
        image::imageops::overlay(&mut expected, &body, 0, HEADER as i64);
        // 吸底栏只出现一次，紧接在累积正文之后（最底部）
        image::imageops::overlay(&mut expected, &footer, 0, (HEADER + covered_body) as i64);

        // 逐帧拼接（复刻主循环的调用方式）
        let mut canvas: Vec<u8> = Vec::new();
        let mut canvas_h = 0u32;
        let f0 = frame(0);
        append_band(&mut canvas, W, &mut canvas_h, &f0, HEADER, FOOTER, 0).unwrap();
        assert_eq!(canvas_h, H - FOOTER, "起始帧应是 页头+正文（吸底栏收尾再贴）");
        let mut last = f0.clone();
        for i in 1..=steps {
            let cur = frame(i * step);
            append_band(&mut canvas, W, &mut canvas_h, &cur, HEADER, FOOTER, step).unwrap();
            // 核心不变量：每一步净增恰好等于位移 —— 早期 append_y 公式会少掉 bottom_fixed
            assert_eq!(
                canvas_h,
                H - FOOTER + i * step,
                "第 {i} 步净增应为 {step}（早期 append_y 公式会让净增少掉 bottom_fixed）"
            );
            last = cur;
        }
        // 收尾：贴上最后一帧的吸底栏
        attach_footer(&mut canvas, W, &mut canvas_h, &last, FOOTER);

        assert_eq!(
            canvas_h,
            HEADER + covered_body + FOOTER,
            "拼接结果高度不对：每步净增必须恰好等于位移（{}）",
            step
        );
        let got = RgbaImage::from_raw(W, canvas_h, canvas).unwrap();
        assert_eq!(
            got.dimensions(),
            expected.dimensions(),
            "拼接结果尺寸与期望不一致"
        );
        let mut bad_row = None;
        for y in 0..canvas_h {
            if got.get_pixel(0, y) != expected.get_pixel(0, y) {
                bad_row = Some(y);
                break;
            }
        }
        assert_eq!(
            bad_row, None,
            "第 {:?} 行与期望不符（重复段/漏段/页头页脚位置错）",
            bad_row
        );
    }

    #[test]
    fn runtime_first_frame_trims_footer_after_first_match() {
        // `run_session` 的真实顺序：首帧先完整写入（尚不知道页脚高度），
        // 第一对帧匹配后才获知 footer。这个回归测试防止页脚留在长图中间。
        const W: u32 = 64;
        const H: u32 = 300;
        const HEADER: u32 = 40;
        const FOOTER: u32 = 30;
        const SHIFT: u32 = 100;
        let (first, second) = make_pair(W, H, SHIFT, HEADER, FOOTER);
        let mut canvas = Vec::new();
        let mut canvas_h = 0;

        append_band(&mut canvas, W, &mut canvas_h, &first, 0, 0, 0).unwrap();
        assert_eq!(canvas_h, H, "真实运行中首帧会先完整入画");
        assert!(trim_initial_footer(&mut canvas, W, &mut canvas_h, FOOTER));
        assert_eq!(canvas_h, H - FOOTER);

        append_band(&mut canvas, W, &mut canvas_h, &second, HEADER, FOOTER, SHIFT).unwrap();
        assert_eq!(
            canvas_h,
            H - FOOTER + SHIFT,
            "剔除首帧页脚后，每帧净增应恰好等于位移"
        );
    }
}

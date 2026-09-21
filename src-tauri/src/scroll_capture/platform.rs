use super::frame_metrics;
use super::{RectPx, ScrollMethod, ScrollState, SettleResult, WinInfo};
use image::RgbaImage;
use std::time::{Duration, Instant};

/// 一格滚轮的 delta（`WHEEL_DELTA`，windows crate 里没有该常量，硬编码）
pub const WHEEL_DELTA: u32 = 120;

const STABLE_DIFF_RATIO: f32 = 0.001;
const STABLE_POLLS: u32 = 3;
const DIFF_TOLERANCE: i16 = 2;

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
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW,
    SetCursorPos, SetForegroundWindow, ShowWindow, WindowFromPoint, CWP_SKIPINVISIBLE, GA_ROOT,
    SB_LINEDOWN, SB_VERT, SCROLLINFO, SIF_ALL, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_MAXIMIZE, SW_RESTORE, WM_KEYDOWN, WM_KEYUP,
    WM_MOUSEWHEEL, WM_VSCROLL,
};

/// 把裸指针封装的 HWND 在跨函数传递时用 isize 表示（HWND 不是 Send）。
pub(super) fn hwnd_from(raw: isize) -> HWND {
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
pub(crate) fn make_lparam(x: i32, y: i32) -> isize {
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
        RgbaImage::from_raw(rect.w, rect.h, buf)
            .ok_or_else(|| "RgbaImage::from_raw 失败".to_string())
    }
}

// ---------- 帧比较 / 稳定等待 ----------

/// 两帧的差异像素占比（隔行隔列采样，只用于「是否稳定」的判定）
pub fn frame_diff_ratio(a: &RgbaImage, b: &RgbaImage) -> f32 {
    frame_metrics::diff_ratio(a, b, DIFF_TOLERANCE)
}

/// 等待画面稳定后返回一帧。
///
/// 比 ShareX 的固定 `ScrollDelay` 稳：慢渲染页面 / 懒加载列表在固定延迟下会截到
/// 「滚了一半」的中间态，这里改成「连续 [`STABLE_POLLS`] 次捕获一致才认为稳定」
/// （不能只比两次：Chrome 的平滑滚动收尾阶段每次只挪一两个像素，两次就够骗过阈值了）。
pub fn settle_capture(
    rect: &RectPx,
    timeout_ms: u64,
    poll_ms: u64,
) -> Result<SettleResult, String> {
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

pub(super) fn window_info(hwnd: HWND) -> Option<WinInfo> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let raw = hwnd.0 as isize;
    Some(WinInfo {
        hwnd: raw,
        pid,
        title: window_title(hwnd),
        class: window_class(hwnd),
        rect: window_rect(raw).unwrap_or(RectPx {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
        }),
        client: client_rect(raw).unwrap_or(RectPx {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
        }),
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
        if best
            .as_ref()
            .map(|b| w.rect.area() > b.rect.area())
            .unwrap_or(true)
        {
            best = Some(w);
        }
    }
    best.ok_or_else(|| format!("未找到匹配窗口 (pid={:?}, title~={:?})", pid, title_substr))
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
pub fn scroll_state(raw: isize) -> Option<ScrollState> {
    unsafe {
        let mut si = SCROLLINFO {
            cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
            fMask: SIF_ALL,
            ..Default::default()
        };
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
                Ok(format!(
                    "SendInput(MOUSEEVENTF_WHEEL x{notches}) @ ({cx},{cy})"
                ))
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
                Ok(format!(
                    "WM_VSCROLL/SB_LINEDOWN x{notches} → hwnd 0x{target:X}"
                ))
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
                Ok(format!(
                    "WM_KEYDOWN/UP VK_NEXT x{notches} → hwnd 0x{target:X}"
                ))
            }
        }
    }
}

/// 把目标区域滚回顶部：向上狂发滚轮（顶部处无效滚动是安全的空操作）。
pub fn scroll_to_top(
    root: isize,
    rect: &RectPx,
    method: ScrollMethod,
    notches: u32,
) -> Result<(), String> {
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

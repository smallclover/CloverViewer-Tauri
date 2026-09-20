use image::RgbaImage;

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

/// 最大化窗口被一键框选时，选区会包含右侧的窗口滚动条。滚动条的滑块会随每帧移动，
/// 若照常拼接就会在长图里留下多段滑块。仅对完整窗口选区预留该窄条：普通自定义选区
/// 不裁，且正文不会在帧间混入滚动条像素。
pub(crate) fn exclude_full_window_scrollbar(
    rect: RectPx,
    window: RectPx,
    gutter: u32,
) -> Option<RectPx> {
    // `pick_window_at` 使用 DWM 可见边界，而 GetWindowRect 还可能包含 8px 左右的
    // 不可见 resize border；允许少量差异，避免最大化窗口因这点误差漏掉优化。
    const EDGE_TOLERANCE: i32 = 12;
    let is_full_window = (rect.x - window.x).abs() <= EDGE_TOLERANCE
        && (rect.y - window.y).abs() <= EDGE_TOLERANCE
        && (rect.right() - window.right()).abs() <= EDGE_TOLERANCE
        && (rect.bottom() - window.bottom()).abs() <= EDGE_TOLERANCE;
    if !is_full_window || gutter >= rect.w.saturating_sub(32) {
        return None;
    }
    Some(RectPx {
        w: rect.w - gutter,
        ..rect
    })
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
        Self::ALL
            .into_iter()
            .find(|m| m.name() == s)
            .or(match s.as_str() {
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
        self.page > 0 && self.track_pos + self.page > self.max
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

// ============================================================

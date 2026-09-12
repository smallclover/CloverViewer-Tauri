//! 滚动截图 P0 兼容性探针（独立二进制，只用于开发验证，不参与发布产物）。
//!
//! 对应 `SCROLL_CAPTURE_PLAN.md` 第 9 节的 P0：在真实应用上验证
//! 「区域捕获可用 + 四种滚动注入方式哪些能滚 + 稳定帧等待是否可靠」，
//! 结论回填方案文档的附录 A（兼容性矩阵）。
//!
//! 用法（在 `src-tauri` 目录下）：
//!
//! ```text
//! # 列出当前可见顶层窗口（找目标）
//! cargo run --bin scroll_probe -- --list
//!
//! # 对标题含 cloverprobe 的窗口做全方法探测，并把帧存到临时目录
//! cargo run --bin scroll_probe -- --title cloverprobe --dump D:\tmp\probe
//!
//! # 指定区域与单方法
//! cargo run --bin scroll_probe -- --pid 1234 --rect 100,200,800,600 --methods wheel_post --notches 1 --steps 3
//! ```
//!
//! 注意：探针会**移动鼠标光标、抢前台焦点、最大化目标窗口**（都会尽力还原），
//! 所以只应指向自己刚启动的测试窗口（用 `--title` 的唯一标记锁定）。
#![cfg_attr(not(target_os = "windows"), allow(unused))]

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("scroll_probe 仅支持 Windows");
}

#[cfg(target_os = "windows")]
fn main() {
    win_impl::run();
}

#[cfg(target_os = "windows")]
mod win_impl {
    use cloverviewer_tauri_lib::scroll_capture::{
        self as sc, RectPx, ScrollCaptureProgress, ScrollCaptureRequest, ScrollMethod,
    };
    use std::path::PathBuf;
    use std::time::Duration;

    #[derive(Debug)]
    struct Args {
        pid: Option<u32>,
        title: Option<String>,
        rect: Option<RectPx>,
        methods: Vec<ScrollMethod>,
        notches: u32,
        steps: u32,
        timeout_ms: u64,
        poll_ms: u64,
        inset: i32,
        maximize: bool,
        focus: bool,
        dump: Option<PathBuf>,
        ascii: u32,
        verbose: bool,
        list: bool,
        restore_foreground: bool,
        /// 跑完整会话（探测 → 逐帧拼接 → 存 PNG），而不是只逐方法探测
        session: bool,
        /// 会话结果 PNG 路径
        out: Option<PathBuf>,
        /// 校验长图里的灰阶标尺（tool/scroll-probe/page.html 生成的长图）
        verify_ruler: Option<PathBuf>,
    }

    impl Default for Args {
        fn default() -> Self {
            Self {
                pid: None,
                title: None,
                rect: None,
                methods: ScrollMethod::ALL.to_vec(),
                notches: 1,
                steps: 1,
                timeout_ms: 1500,
                poll_ms: 60,
                inset: 12,
                maximize: true,
                focus: true,
                dump: None,
                ascii: 0,
                verbose: false,
                list: false,
                restore_foreground: true,
                session: false,
                out: None,
                verify_ruler: None,
            }
        }
    }

    fn usage() -> String {
        [
            "用法: scroll_probe [选项]",
            "  --pid <N>              按进程号选窗口",
            "  --title <SUBSTR>       按标题子串选窗口（唯一标记，避免误伤用户窗口）",
            "  --rect <x,y,w,h>       显式指定捕获区域（默认：目标窗口客户区内缩 --inset）",
            "  --inset <PX>           客户区内缩像素（默认 12，避开边框/滚动条）",
            "  --methods <LIST>       逗号分隔: wheel_post,wheel_post_root,wheel_input,vscroll,pagedown（默认全部）",
            "  --notches <N>          每次注入几格滚轮（默认 1）",
            "  --steps <N>            每个方法重复几轮（默认 1）",
            "  --timeout <MS>         稳定帧等待超时（默认 1500）",
            "  --poll <MS>            稳定帧轮询间隔（默认 60）",
            "  --dump <DIR>           把每次 before/after 帧存成 PNG（肉眼复核捕获内容）",
            "  --ascii <COLS>         把基线帧渲染成 ASCII 亮度图打印（无图形环境时确认捕获内容）",
            "  --no-maximize          不最大化目标窗口",
            "  --no-focus             不抢前台焦点",
            "  --session              跑完整会话（探测 → 逐帧拼接 → 存长图），而不是只逐方法探测",
            "  --out <FILE>           会话结果 PNG 路径（默认 <dump>/longshot.png）",
            "  --verify-ruler <PNG>   校验长图里的灰阶标尺（page.html 生成的长图：验证无重复段/漏段/错序）",
            "  --no-restore           跑完不还原前台窗口",
            "  --verbose, -v          打印注入前后的前台窗口（排查「滚到别人窗口去了」）",
            "  --list                 只列出可见顶层窗口",
            "  -h, --help             显示帮助",
        ]
        .join("\n")
    }

    fn parse_args() -> Result<Args, String> {
        let mut a = Args::default();
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            let mut next = |name: &str| it.next().ok_or_else(|| format!("{name} 需要一个值"));
            match arg.as_str() {
                "--pid" => a.pid = Some(next("--pid")?.parse().map_err(|e| format!("--pid: {e}"))?),
                "--title" => a.title = Some(next("--title")?),
                "--rect" => {
                    let v = next("--rect")?;
                    let n: Vec<i32> = v
                        .split(',')
                        .map(|s| s.trim().parse::<i32>())
                        .collect::<Result<_, _>>()
                        .map_err(|e| format!("--rect 解析失败: {e}"))?;
                    if n.len() != 4 {
                        return Err("--rect 需要 x,y,w,h 四个数".into());
                    }
                    a.rect = Some(RectPx {
                        x: n[0],
                        y: n[1],
                        w: n[2].max(1) as u32,
                        h: n[3].max(1) as u32,
                    });
                }
                "--inset" => a.inset = next("--inset")?.parse().map_err(|e| format!("--inset: {e}"))?,
                "--methods" => {
                    let v = next("--methods")?;
                    let mut list = Vec::new();
                    for part in v.split(',') {
                        let part = part.trim();
                        if part.is_empty() {
                            continue;
                        }
                        list.push(
                            ScrollMethod::parse(part)
                                .ok_or_else(|| format!("未知方法: {part}"))?,
                        );
                    }
                    if list.is_empty() {
                        return Err("--methods 为空".into());
                    }
                    a.methods = list;
                }
                "--notches" => {
                    a.notches = next("--notches")?.parse().map_err(|e| format!("--notches: {e}"))?
                }
                "--steps" => a.steps = next("--steps")?.parse().map_err(|e| format!("--steps: {e}"))?,
                "--timeout" => {
                    a.timeout_ms = next("--timeout")?.parse().map_err(|e| format!("--timeout: {e}"))?
                }
                "--poll" => a.poll_ms = next("--poll")?.parse().map_err(|e| format!("--poll: {e}"))?,
                "--dump" => a.dump = Some(PathBuf::from(next("--dump")?)),
                "--ascii" => {
                    a.ascii = next("--ascii")?.parse().map_err(|e| format!("--ascii: {e}"))?
                }
                "--no-maximize" => a.maximize = false,                "--no-focus" => a.focus = false,
                "--no-restore" => a.restore_foreground = false,
                "--verbose" | "-v" => a.verbose = true,
                "--session" => a.session = true,
                "--out" => a.out = Some(PathBuf::from(next("--out")?)),
                "--verify-ruler" => a.verify_ruler = Some(PathBuf::from(next("--verify-ruler")?)),
                "--list" => a.list = true,
                "-h" | "--help" => {
                    println!("{}", usage());
                    std::process::exit(0);
                }
                other => return Err(format!("未知参数: {other}\n\n{}", usage())),
            }
        }
        Ok(a)
    }

    fn print_windows() {
        println!(
            "{:<12} {:<8} {:<28} {:<22} {}",
            "HWND", "PID", "CLASS", "RECT", "TITLE"
        );
        for w in sc::list_top_windows() {
            println!(
                "{:<12} {:<8} {:<28} {:<22} {}",
                w.hwnd_str(),
                w.pid,
                truncate(&w.class, 27),
                format!("{},{},{}x{}", w.rect.x, w.rect.y, w.rect.w, w.rect.h),
                truncate(&w.title, 60)
            );
        }
    }

    fn truncate(s: &str, n: usize) -> String {
        if s.chars().count() <= n {
            s.to_string()
        } else {
            let t: String = s.chars().take(n.saturating_sub(1)).collect();
            format!("{t}…")
        }
    }

    fn dump_frame(dir: &Option<PathBuf>, name: &str, img: &image::RgbaImage) {
        let Some(dir) = dir else { return };
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[warn] 创建 dump 目录失败: {e}");
            return;
        }
        let path = dir.join(format!("{name}.png"));
        if let Err(e) = img.save(&path) {
            eprintln!("[warn] 保存 {path:?} 失败: {e}");
        }
    }

    /// 把捕获帧渲染成 ASCII（亮度分级），用于在无图形界面的终端里**肉眼确认捕获到的到底是什么**
    /// （黑屏 / 目标窗口 / 被自己的控制台挡住…）。字符高宽比约 2:1，故纵向采样折半。
    fn ascii_render(img: &image::RgbaImage, cols: u32) -> String {
        let (w, h) = img.dimensions();
        if w == 0 || h == 0 {
            return String::new();
        }
        let cols = cols.clamp(20, 240);
        let rows = (((h as f32 / w as f32) * cols as f32 * 0.5).round() as u32).max(1);
        let cw = w as f32 / cols as f32;
        let ch = h as f32 / rows as f32;
        let raw = img.as_raw();
        let ramp: &[u8] = b" .:-=+*#%@";
        let mut out = String::with_capacity(((cols + 1) * rows) as usize);
        for r in 0..rows {
            for c in 0..cols {
                let x0 = (c as f32 * cw) as u32;
                let x1 = (((c + 1) as f32 * cw) as u32).clamp(x0 + 1, w);
                let y0 = (r as f32 * ch) as u32;
                let y1 = (((r + 1) as f32 * ch) as u32).clamp(y0 + 1, h);
                let (mut sum, mut n) = (0u64, 0u64);
                for y in (y0..y1).step_by(3) {
                    for x in (x0..x1).step_by(3) {
                        let i = ((y * w + x) * 4) as usize;
                        let l = (299 * raw[i] as u64 + 587 * raw[i + 1] as u64 + 114 * raw[i + 2] as u64) / 1000;
                        sum += l;
                        n += 1;
                    }
                }
                let l = if n == 0 { 0 } else { (sum / n) as usize };
                out.push(ramp[(l * (ramp.len() - 1) / 255).min(ramp.len() - 1)] as char);
            }
            out.push('\n');
        }
        out
    }

    /// 一段区域的平均亮度与颜色种类粗估（判断「是不是黑屏/纯色」）
    fn slot_stats(img: &image::RgbaImage) -> String {
        let raw = img.as_raw();
        let mut sum = [0u64; 3];
        let mut n = 0u64;
        let mut min = u8::MAX;
        let mut max = 0u8;
        for px in raw.chunks_exact(4) {
            let l = ((px[0] as u32 + px[1] as u32 + px[2] as u32) / 3) as u8;
            min = min.min(l);
            max = max.max(l);
            sum[0] += px[0] as u64;
            sum[1] += px[1] as u64;
            sum[2] += px[2] as u64;
            n += 1;
        }
        if n == 0 {
            return "n/a".into();
        }
        format!(
            "mean=#{:02X}{:02X}{:02X} luma范围={}..{}",
            (sum[0] / n) as u8,
            (sum[1] / n) as u8,
            (sum[2] / n) as u8,
            min,
            max
        )
    }

    fn fmt_state(s: Option<sc::ScrollState>) -> String {
        match s {
            Some(s) => format!(
                "min={} max={} pos={} page={} track={}{}",
                s.min,
                s.max,
                s.pos,
                s.page,
                s.track_pos,
                if s.at_bottom() { " [到底]" } else { "" }
            ),
            None => "（无标准滚动条）".to_string(),
        }
    }

    /// 顶层窗口 + 光标下最深层子窗口的滚动条状态。
    /// **滚动条通常长在子窗口上**（ListBox / Edit / Explorer 的 DirectUIHWND），
    /// 只查顶层会误判成「无滚动条」。
    fn fmt_state_both(root: isize, rect: &RectPx) -> String {
        let (cx, cy) = rect.center();
        let deepest = sc::deepest_child_at(cx, cy);
        let child_state = deepest.map(|h| format!("0x{h:X} {}", fmt_state(sc::scroll_state(h))));
        format!(
            "顶层 0x{root:X} {} | 子 {}",
            fmt_state(sc::scroll_state(root)),
            child_state.unwrap_or_else(|| "n/a".into())
        )
    }

    /// 「是否发生了滚动」的最硬证据：子窗口滚动条位置变化。
    /// 注意：**不要**用像素 diff 当判据 —— 内容重复（等距同款列表）时滚动前后画面几乎一致，
    /// diff 只有千分之几，会误判成「没滚」（P0 实测）。
    fn scroll_pos(root: isize, rect: &RectPx) -> Option<(i32, i32)> {
        let (cx, cy) = rect.center();
        sc::scroll_state_deepest(root, cx, cy).map(|s| (s.pos, s.track_pos))
    }

    fn describe_window(raw: isize) -> String {
        sc::list_top_windows()
            .into_iter()
            .find(|w| w.hwnd == raw)
            .map(|w| format!("0x{:X} [{}] {}", w.hwnd, w.class, truncate(&w.title, 40)))
            .unwrap_or_else(|| format!("0x{raw:X}（枚举不到）"))
    }

    /// 校验长图里的「灰阶标尺」：每个 section 的标尺把序号编码成灰度，
    /// 于是可以**程序化**判断拼接结果有没有重复段 / 漏段 / 错序。
    ///
    /// 列位置自动定位（不依赖 DPI 缩放）：先找出「几乎每行都接近纯黑」的列带（标尺黑边），
    /// 它右边紧接着的一段非黑列就是灰条，取其中点采样。
    fn verify_ruler(path: &std::path::Path) -> i32 {
        let img = match image::open(path) {
            Ok(i) => i.to_rgba8(),
            Err(e) => {
                eprintln!("[错误] 读取 {path:?} 失败: {e}");
                return 2;
            }
        };
        let (w, h) = img.dimensions();
        if w < 120 || h < 40 {
            eprintln!("[错误] 图太小: {w}x{h}");
            return 2;
        }
        let is_black = |p: &image::Rgba<u8>| p[0] < 24 && p[1] < 24 && p[2] < 24;
        let scan_w = w.min(240);
        let mut black_ratio = vec![0f32; scan_w as usize];
        for x in 0..scan_w {
            let mut n = 0u32;
            for y in 0..h {
                if is_black(img.get_pixel(x, y)) {
                    n += 1;
                }
            }
            black_ratio[x as usize] = n as f32 / h as f32;
        }
        let Some(b0) = (0..scan_w as usize).find(|x| black_ratio[*x] > 0.5) else {
            eprintln!("[错误] 找不到标尺黑边（这张图不是 page.html 生成的长图？）");
            return 3;
        };
        let mut b1 = b0;
        while b1 < scan_w as usize && black_ratio[b1] > 0.5 {
            b1 += 1;
        }
        let bar0 = b1;
        let mut bar1 = bar0;
        while bar1 < scan_w as usize && black_ratio[bar1] <= 0.5 {
            bar1 += 1;
        }
        if bar1 <= bar0 {
            eprintln!("[错误] 找不到标尺灰条");
            return 3;
        }
        let blk_x = (b0 + (b1 - b0) / 2) as u32;
        let bar_x = ((bar0 + bar1) / 2) as u32;
        println!("  标尺定位: 黑边列 {b0}..{b1}，灰条列 {bar0}..{bar1}（采样 x={bar_x}，黑边校验 x={blk_x}）");

        let mut seq: Vec<i32> = Vec::new();
        let mut rows_ok = 0u32;
        let mut rows_skipped = 0u32;
        for y in 0..h {
            if !is_black(img.get_pixel(blk_x, y)) {
                continue;
            }
            let bar = img.get_pixel(bar_x, y);
            let grayish = (bar[0] as i32 - bar[1] as i32).abs() < 16
                && (bar[1] as i32 - bar[2] as i32).abs() < 16;
            if !grayish {
                rows_skipped += 1;
                continue;
            }
            // 页面里 index → 灰度字节 = 26 + 3*index（见 page.html 的 .ruler）
            let idx = ((bar[0] as f32 - 26.0) / 3.0).round() as i32;
            if !(0..=250).contains(&idx) {
                rows_skipped += 1;
                continue;
            }
            rows_ok += 1;
            if seq.last() != Some(&idx) {
                seq.push(idx);
            }
        }
        println!("  标尺行: {rows_ok}（非灰/越界跳过 {rows_skipped}）");
        println!("  段序号序列（已折叠连续重复，共 {} 段）: {:?}", seq.len(), seq);

        let mut errs: Vec<String> = Vec::new();
        if seq.is_empty() {
            errs.push("没有解出任何序号（标尺可能被遮挡或没截到）".to_string());
        } else {
            if seq[0] != 0 {
                errs.push(format!("首段序号是 {} 而不是 0（起点没截到）", seq[0]));
            }
            for win in seq.windows(2) {
                if win[1] != win[0] + 1 {
                    let kind = if win[1] > win[0] + 1 {
                        format!("漏了 {} 段", win[1] - win[0] - 1)
                    } else {
                        "错序/回退".to_string()
                    };
                    errs.push(format!("序号跳变 {} → {}（{kind}）", win[0], win[1]));
                }
            }
        }
        if errs.is_empty() {
            println!("  ✅ 标尺校验通过：段序号严格 +1 递增，无重复、无漏段、无错序");
            0
        } else {
            for e in errs.iter().take(20) {
                println!("  ❌ {e}");
            }
            if errs.len() > 20 {
                println!("  ❌ …（共 {} 处问题）", errs.len());
            }
            println!("  ❌ 标尺校验未通过");
            1
        }
    }

    /// 命令行侧的最小宿主：只实现「把目标窗口提到前台」。
    ///
    /// 这一条不能省：屏幕像素捕获 + SendInput 都要求目标窗口在最上面，
    /// 否则截到/滚到的是压在上面的别的窗口（P1 实测：不提升前台时资源管理器
    /// 会话直接判定「滚不动」）。应用里由 `TauriHost` 负责同一件事。
    struct ProbeHost;
    impl sc::SessionHost for ProbeHost {
        fn set_passthrough(&self, _on: bool) {}
        fn focus_target(&self, hwnd: isize) {
            let _ = sc::focus_window(hwnd);
        }
        fn set_escape_hook(&self, _on: bool) {}
    }

    pub fn run() {
        let args = match parse_args() {
            Ok(a) => a,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(2);
            }
        };

        // 必须在任何窗口/坐标操作之前
        sc::ensure_dpi_aware();

        // 独立模式：只校验一张已生成的长图
        if let Some(png) = args.verify_ruler.clone() {
            println!("== 标尺校验 == {}", png.display());
            let code = verify_ruler(&png);
            std::process::exit(code);
        }

        if args.list {
            print_windows();
            return;
        }

        let prev_foreground = sc::foreground_window();

        let win = match sc::resolve_window(args.pid, args.title.as_deref()) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[错误] {e}");
                eprintln!("提示：用 --list 看看有哪些可见窗口，或先用 --title 指定唯一标记。");
                std::process::exit(3);
            }
        };

        println!("== 目标窗口 ==");
        println!("  hwnd      : {}", win.hwnd_str());
        println!("  pid       : {}", win.pid);
        println!("  class     : {}", win.class);
        println!("  title     : {}", win.title);
        println!(
            "  window    : {},{},{}x{}",
            win.rect.x, win.rect.y, win.rect.w, win.rect.h
        );
        println!(
            "  client    : {},{},{}x{}",
            win.client.x, win.client.y, win.client.w, win.client.h
        );

        if args.maximize {
            sc::maximize_window(win.hwnd);
            std::thread::sleep(Duration::from_millis(400));
        }
        if args.focus {
            let ok = sc::focus_window(win.hwnd);
            println!("  focus     : {}", if ok { "ok" } else { "被系统拒绝（继续）" });
            std::thread::sleep(Duration::from_millis(400));
        }

        // 最大化之后重新读一次客户区
        let client = sc::client_rect(win.hwnd).unwrap_or(win.client);
        let rect = args.rect.unwrap_or_else(|| client.inset(args.inset));
        println!(
            "== 捕获区域 == {},{},{}x{}（客户区内缩 {}px）",
            rect.x, rect.y, rect.w, rect.h, args.inset
        );

        let deepest = sc::deepest_child_at(rect.center().0, rect.center().1).unwrap_or(0);
        println!(
            "  中心点 ({},{}) 处最深层子窗口: 0x{deepest:X}（顶层 0x{:X}）",
            rect.center().0,
            rect.center().1,
            win.hwnd
        );

        // ---- 完整会话模式：探测 → 逐帧拼接 → 存长图 ----
        if args.session {
            let mut req = ScrollCaptureRequest::new(rect.x, rect.y, rect.w, rect.h);
            // --methods 只给一个时视为「强制用这种注入方式」
            if args.methods.len() == 1 {
                req.method = Some(args.methods[0].name().to_string());
            }
            let opts = match sc::SessionOptions::from_request(&req) {
                Ok(o) => o,
                Err(e) => {
                    eprintln!("[错误] 参数无效: {e}");
                    std::process::exit(5);
                }
            };
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let mut emit = |p: ScrollCaptureProgress| {
                println!(
                    "  [{}] 帧={} 高={}px 方式={} 穿透={} {}",
                    p.stage,
                    p.frames,
                    p.height,
                    p.method.clone().unwrap_or_else(|| "-".to_string()),
                    if p.input_passthrough { "是" } else { "否" },
                    p.message.clone().unwrap_or_default()
                );
            };
            let t0 = std::time::Instant::now();
            println!("== 滚动截图会话 ==");
            match sc::run_session(&req, &opts, &ProbeHost, &cancel, &mut emit) {
                Ok(res) => {
                    let out = args
                        .out
                        .clone()
                        .unwrap_or_else(|| PathBuf::from("longshot.png"));
                    if let Err(e) = std::fs::write(&out, &res.png) {
                        eprintln!("[错误] 写 PNG 失败: {e}");
                        std::process::exit(6);
                    }
                    println!("== 会话完成 ==");
                    println!(
                        "  {}x{} 帧={} 置信度={} 耗时={}ms PNG={}KB",
                        res.width,
                        res.height,
                        res.frames,
                        res.confidence,
                        t0.elapsed().as_millis(),
                        res.png.len() / 1024
                    );
                    if let Some(m) = &res.message {
                        println!("  说明: {m}");
                    }
                    println!("  已写入: {}", out.display());
                    println!("  下一步: scroll_probe --verify-ruler {}", out.display());
                }
                Err(e) => {
                    eprintln!("[错误] 会话失败: {e}");
                    if args.restore_foreground && prev_foreground != 0 {
                        sc::focus_window(prev_foreground);
                    }
                    std::process::exit(7);
                }
            }
            if args.restore_foreground && prev_foreground != 0 && prev_foreground != win.hwnd {
                sc::focus_window(prev_foreground);
            }
            return;
        }

        // 基线帧（同时验证区域捕获本身可用）
        let baseline = match sc::settle_capture(&rect, args.timeout_ms, args.poll_ms) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[错误] 捕获区域失败: {e}");
                std::process::exit(4);
            }
        };
        println!(
            "  基线帧: {}x{} 稳定耗时 {}ms（{} 次轮询{}）",
            baseline.image.width(),
            baseline.image.height(),
            baseline.elapsed_ms,
            baseline.polls,
            if baseline.timed_out { "，⚠ 超时未稳定" } else { "" }
        );
        dump_frame(&args.dump, "00_baseline", &baseline.image);
        println!("  基线帧统计: {}", slot_stats(&baseline.image));
        if args.ascii > 0 {
            println!("  基线帧 ASCII（{} 列，亮度分级）:", args.ascii);
            print!("{}", ascii_render(&baseline.image, args.ascii));
        }
        println!("  GetScrollInfo: {}", fmt_state(sc::scroll_state(win.hwnd)));
        println!();

        println!("== 逐方法探测 ==");
        let mut summary: Vec<(ScrollMethod, bool, Vec<u32>, f32)> = Vec::new();

        for method in &args.methods {
            let mut ok_steps = 0u32;
            let mut shifts: Vec<u32> = Vec::new();
            let mut last_diff = 0.0f32;
            println!("--- {} ---", method.name());

            for step in 0..args.steps.max(1) {
                let before = match sc::settle_capture(&rect, args.timeout_ms, args.poll_ms) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("  [错误] 捕获失败: {e}");
                        break;
                    }
                };
                let state_before_all = fmt_state_both(win.hwnd, &rect);
                let pos_before = scroll_pos(win.hwnd, &rect);

                let inject_desc = match sc::inject_scroll(win.hwnd, &rect, *method, args.notches) {
                    Ok(d) => d,
                    Err(e) => {
                        println!("  step{}: 注入失败: {e}", step + 1);
                        break;
                    }
                };

                let fg_before = sc::foreground_window();

                let after = match sc::settle_capture(&rect, args.timeout_ms, args.poll_ms) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("  [错误] 捕获失败: {e}");
                        break;
                    }
                };
                let state_after_all = fmt_state_both(win.hwnd, &rect);
                let pos_after = scroll_pos(win.hwnd, &rect);

                let diff = sc::frame_diff_ratio(&before.image, &after.image);
                last_diff = diff;
                let est = sc::estimate_shift(&before.image, &after.image);

                dump_frame(
                    &args.dump,
                    &format!("{}_{:02}_before", method.name(), step + 1),
                    &before.image,
                );
                dump_frame(
                    &args.dump,
                    &format!("{}_{:02}_after", method.name(), step + 1),
                    &after.image,
                );

                // 判定：滚动条位置变化 / 像素差异显著 / 位移估计置信
                let vs_moved = match (pos_before, pos_after) {
                    (Some(b), Some(a)) => a != b,
                    _ => false,
                };
                let est_ok = est
                    .map(|e| e.shift > 0 && e.err < 6.0 && e.improvement() > 3.0)
                    .unwrap_or(false);
                let scrolled = vs_moved || diff > 0.005 || est_ok;
                if scrolled {
                    ok_steps += 1;
                }
                if let Some(e) = est {
                    if e.shift > 0 && e.err < 6.0 {
                        shifts.push(e.shift);
                    }
                }

                println!(
                    "  step{}: {} | diff={:.4} | 位移≈{}{} | 稳定={}ms{} | 滚动条: {} → {}",
                    step + 1,
                    inject_desc,
                    diff,
                    est.map(|e| format!("{}px", e.shift)).unwrap_or_else(|| "n/a".into()),
                    est.map(|e| format!(
                        " (err={:.2}, err@0={:.2}, x{})",
                        e.err,
                        e.err_at_zero,
                        if e.improvement().is_finite() {
                            format!("{:.0}", e.improvement())
                        } else {
                            "∞".into()
                        }
                    ))
                    .unwrap_or_default(),
                    after.elapsed_ms,
                    if after.timed_out { "⚠超时" } else { "" },
                    state_before_all,
                    state_after_all,
                );
                if args.verbose {
                    println!(
                        "          前台窗口(注入前后): {} / {}",
                        describe_window(fg_before),
                        describe_window(sc::foreground_window())
                    );
                }

                std::thread::sleep(Duration::from_millis(120));
            }

            let verdict = if ok_steps == 0 {
                "❌ 未滚动"
            } else if ok_steps == args.steps.max(1) {
                "✅ 可滚动"
            } else {
                "⚠ 部分成功"
            };
            println!(
                "  → {} ({}/{}) 位移样本: {:?} 末次diff={:.4}",
                verdict,
                ok_steps,
                args.steps.max(1),
                shifts,
                last_diff
            );
            println!();
            summary.push((*method, ok_steps > 0, shifts, last_diff));
        }

        println!("== 汇总 ==");
        for (m, ok, shifts, diff) in &summary {
            println!(
                "  {:<16} {:<6} 位移≈{:<16} diff={:.4}",
                m.name(),
                if *ok { "可滚动" } else { "不可滚" },
                if shifts.is_empty() {
                    "-".to_string()
                } else {
                    format!("{:?}", shifts)
                },
                diff
            );
        }

        // 尽力还原现场
        if args.restore_foreground && prev_foreground != 0 && prev_foreground != win.hwnd {
            sc::focus_window(prev_foreground);
        }
    }
}

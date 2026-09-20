use super::stitching::{append_band, attach_footer, duplicate_ratio, trim_initial_footer};
use super::*;
use image::{Rgba, RgbaImage};

// 单元测试（无需真实屏幕：只测与 Win32 无关的纯逻辑）
// ============================================================

#[test]
fn session_options_normalize_input_and_preserve_valid_method() {
    let mut req = ScrollCaptureRequest::new(10, 20, 300, 400);
    req.method = Some(" INPUT ".to_string());
    req.notches = Some(99);
    req.settle_timeout_ms = Some(1);
    req.poll_ms = Some(9_999);
    req.max_height_px = Some(1);
    req.max_frames = Some(9_999);
    req.focus_target = Some(false);

    let options = SessionOptions::from_request(&req).expect("合法别名应被接受");
    assert_eq!(options.method, Some(ScrollMethod::WheelInput));
    assert_eq!(options.notches, Some(40));
    assert_eq!(options.settle_timeout_ms, 200);
    assert_eq!(options.poll_ms, 500);
    assert_eq!(options.max_height_px, 200);
    assert_eq!(options.max_frames, 2_000);
    assert!(!options.focus_target);
    assert_eq!(
        req.rect(),
        RectPx {
            x: 10,
            y: 20,
            w: 300,
            h: 400
        }
    );
}

#[test]
fn session_options_reject_unknown_method() {
    let mut req = ScrollCaptureRequest::new(0, 0, 300, 400);
    req.method = Some("not-a-scroll-method".to_string());
    assert!(SessionOptions::from_request(&req)
        .expect_err("未知注入方式不能静默回退")
        .contains("未知滚动方式"));
}

#[test]
fn rect_inset_and_center() {
    let r = RectPx {
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
fn full_window_capture_excludes_only_the_scrollbar_gutter() {
    let window = RectPx {
        x: 0,
        y: 0,
        w: 1920,
        h: 1040,
    };
    let cropped =
        exclude_full_window_scrollbar(window, window, 18).expect("完整窗口选区应预留滚动条");
    assert_eq!(cropped, RectPx { w: 1902, ..window });

    // DWM 可见边界和 GetWindowRect 有少量差异时仍应识别为同一个最大化窗口。
    let visible = RectPx {
        x: 8,
        y: 8,
        w: 1904,
        h: 1024,
    };
    assert_eq!(
        exclude_full_window_scrollbar(visible, window, 18),
        Some(RectPx { w: 1886, ..visible })
    );

    let custom = RectPx {
        x: 24,
        y: 24,
        w: 1800,
        h: 960,
    };
    assert_eq!(exclude_full_window_scrollbar(custom, window, 18), None);
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
fn exact_shift_match_reports_unbounded_improvement() {
    let estimate = ShiftEstimate {
        shift: 10,
        err: 0.0,
        err_at_zero: 12.0,
    };
    assert!(estimate.improvement().is_infinite());
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

    let different_size = RgbaImage::from_pixel(32, 64, image::Rgba([10, 10, 10, 255]));
    assert_eq!(
        frame_diff_ratio(&a, &different_size),
        1.0,
        "尺寸不一致必须拒绝比较"
    );
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
            img.put_pixel(
                x,
                y,
                image::Rgba([v, v.wrapping_add(37), v.wrapping_mul(3), 255]),
            );
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
    let m = match_frames(&prev, &cur, &MatchParams::for_height(h), None).expect("应匹配成功");
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
    assert_eq!(
        canvas_h,
        H - FOOTER,
        "起始帧应是 页头+正文（吸底栏收尾再贴）"
    );
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

    append_band(
        &mut canvas,
        W,
        &mut canvas_h,
        &second,
        HEADER,
        FOOTER,
        SHIFT,
    )
    .unwrap();
    assert_eq!(
        canvas_h,
        H - FOOTER + SHIFT,
        "剔除首帧页脚后，每帧净增应恰好等于位移"
    );
}

#[test]
fn stitching_rejects_incompatible_frames_without_corrupting_canvas() {
    let frame = RgbaImage::from_pixel(12, 20, Rgba([1, 2, 3, 255]));
    let mut canvas = vec![9; 12 * 4 * 3];
    let original = canvas.clone();
    let mut canvas_h = 3;

    let error = append_band(&mut canvas, 11, &mut canvas_h, &frame, 0, 0, 0)
        .expect_err("不同宽度的帧不能拼接");
    assert!(error.contains("不一致"));
    assert_eq!(canvas, original, "失败不能改写已有画布");
    assert_eq!(canvas_h, 3, "失败不能改变高度账本");
    assert!(!trim_initial_footer(&mut canvas, 12, &mut canvas_h, 4));
}

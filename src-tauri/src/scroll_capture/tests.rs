use super::engine::{CaptureEngine, EngineEvent};
use super::matching::{FrameRegistrar, RegistrationVerdict};
use super::stitching::Composer;
use super::*;
use image::{Rgba, RgbaImage};

fn content(width: u32, height: u32) -> RgbaImage {
    let mut image = RgbaImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let mut seed = y
                .wrapping_mul(0x9E37_79B9)
                .wrapping_add(x.wrapping_mul(0x85EB_CA6B))
                | 1;
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            image.put_pixel(
                x,
                y,
                Rgba([(seed >> 8) as u8, (seed >> 16) as u8, seed as u8, 255]),
            );
        }
    }
    image
}

fn frame(source: &RgbaImage, offset: u32, height: u32, header: u32, footer: u32) -> RgbaImage {
    let mut out = RgbaImage::new(source.width(), height);
    for y in 0..height {
        for x in 0..source.width() {
            let pixel = if y < header {
                Rgba([11, 22, 33, 255])
            } else if y >= height - footer {
                Rgba([44, 55, 66, 255])
            } else {
                *source.get_pixel(x, offset + y - header)
            };
            out.put_pixel(x, y, pixel);
        }
    }
    out
}

fn white_article(width: u32, height: u32) -> RgbaImage {
    let mut image = RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]));
    for y in (8..height).step_by(19) {
        let line = 180 + (y % 90);
        for x in 220..(220 + line).min(width) {
            if (x + y) % 7 < 4 {
                image.put_pixel(x, y, Rgba([32, 44, 65, 255]));
                image.put_pixel(x, (y + 1).min(height - 1), Rgba([32, 44, 65, 255]));
            }
        }
    }
    image
}

#[test]
fn v2_registers_a_shift_and_reports_fixed_edges() {
    let source = content(180, 900);
    let previous = frame(&source, 0, 400, 24, 18);
    let current = frame(&source, 80, 400, 24, 18);
    let mut registrar = FrameRegistrar::default();
    let RegistrationVerdict::Accepted(registration) = registrar.register(&previous, &current)
    else {
        panic!("expected accepted registration");
    };
    assert_eq!(registration.shift, 80);
    assert_eq!(registration.top_fixed, 24);
    assert_eq!(registration.bottom_fixed, 18);
    assert!(registration.support > 0.98);
}

#[test]
fn v2_registers_a_large_page_down_shift_when_overlap_remains() {
    let source = content(180, 1_200);
    let previous = frame(&source, 0, 400, 0, 0);
    let current = frame(&source, 330, 400, 0, 0);
    let RegistrationVerdict::Accepted(registration) =
        FrameRegistrar::default().register(&previous, &current)
    else {
        panic!("a PageDown-sized shift with 70px overlap must be accepted");
    };
    assert_eq!(registration.shift, 330);
}

#[test]
fn v2_composes_only_verified_new_rows() {
    let source = content(120, 1000);
    let first = frame(&source, 0, 300, 20, 12);
    let second = frame(&source, 75, 300, 20, 12);
    let third = frame(&source, 150, 300, 20, 12);
    let mut engine = CaptureEngine::new(first);
    let second_event = engine.ingest(second).unwrap();
    assert!(matches!(
        second_event,
        EngineEvent::Appended { shift: 75, .. }
    ));
    assert!(matches!(
        engine.ingest(third).unwrap(),
        EngineEvent::Appended { shift: 75, .. }
    ));
    let result = engine.finish().unwrap();
    assert_eq!(result.height(), 450);
    assert_eq!(*result.get_pixel(4, 0), Rgba([11, 22, 33, 255]));
    assert_eq!(*result.get_pixel(4, 449), Rgba([44, 55, 66, 255]));
    for y in 20..438 {
        assert_eq!(*result.get_pixel(7, y), *source.get_pixel(7, y - 20));
    }
}

#[test]
fn v2_registers_the_moving_content_beside_a_fixed_sidebar() {
    let source = content(200, 900);
    let mut previous = frame(&source, 0, 400, 0, 0);
    let mut current = frame(&source, 70, 400, 0, 0);
    for y in 0..400 {
        for x in 0..80 {
            previous.put_pixel(x, y, Rgba([22, 44, 88, 255]));
            current.put_pixel(x, y, Rgba([22, 44, 88, 255]));
        }
    }
    let RegistrationVerdict::Accepted(registration) =
        FrameRegistrar::default().register(&previous, &current)
    else {
        panic!("the fixed sidebar must be ignored while registering the content");
    };
    assert_eq!(registration.shift, 70);
}

#[test]
fn v2_registers_a_white_article_without_calling_blank_rows_a_sidebar() {
    let source = white_article(700, 1_300);
    let mut previous = frame(&source, 0, 500, 0, 0);
    let mut current = frame(&source, 110, 500, 0, 0);
    for y in 0..500 {
        for x in 0..150 {
            let tone = ((x * 17 + y * 3) % 80) as u8;
            previous.put_pixel(x, y, Rgba([40 + tone, 52 + tone, 78 + tone, 255]));
            current.put_pixel(x, y, Rgba([40 + tone, 52 + tone, 78 + tone, 255]));
        }
    }
    let RegistrationVerdict::Accepted(registration) =
        FrameRegistrar::default().register(&previous, &current)
    else {
        panic!("a white article with a fixed sidebar must still register");
    };
    assert_eq!(registration.shift, 110);
}

#[test]
fn v2_does_not_accept_identical_frames_as_new_content() {
    let image = content(120, 300);
    assert_eq!(
        FrameRegistrar::default().register(&image, &image),
        RegistrationVerdict::NoMotion
    );
}

#[test]
fn manual_anchor_skips_a_duplicate_tail_then_accepts_later_new_content() {
    let source = content(120, 1_000);
    let first = frame(&source, 0, 300, 0, 0);
    let second = frame(&source, 75, 300, 0, 0);
    let third = frame(&source, 150, 300, 0, 0);
    let mut engine = CaptureEngine::new(first);

    assert!(matches!(
        engine.ingest(second.clone()).unwrap(),
        EngineEvent::Appended { .. }
    ));
    // The final settle probe may be identical to the last accepted screen.
    // It must never add a second copy of the visible tail.
    assert!(matches!(
        engine.ingest(second).unwrap(),
        EngineEvent::NoMotion
    ));
    assert_eq!(engine.height(), 375);

    // A skipped frame must not poison the anchor.  Scrolling on afterwards
    // still registers against the last verified frame and remains appendable.
    assert!(matches!(
        engine.ingest(third).unwrap(),
        EngineEvent::Appended { .. }
    ));
    assert_eq!(engine.height(), 450);
}

#[test]
fn manual_anchor_survives_an_unmatched_frame() {
    let source = content(120, 1_000);
    let first = frame(&source, 0, 300, 0, 0);
    let second = frame(&source, 75, 300, 0, 0);
    let third = frame(&source, 150, 300, 0, 0);
    let unrelated = RgbaImage::from_pixel(120, 300, Rgba([213, 77, 19, 255]));
    let mut engine = CaptureEngine::new(first);

    assert!(matches!(
        engine.ingest(second).unwrap(),
        EngineEvent::Appended { .. }
    ));
    assert!(matches!(
        engine.ingest(unrelated).unwrap(),
        EngineEvent::Uncertain { .. }
    ));
    // The only trusted reference is still the last green frame, therefore a
    // later valid frame can recover without a wrong seam or early termination.
    assert!(matches!(
        engine.ingest(third).unwrap(),
        EngineEvent::Appended { .. }
    ));
    assert_eq!(engine.height(), 450);
}

#[test]
fn live_preview_is_bounded_even_for_a_tall_verified_canvas() {
    let composer = Composer::new(content(300, 4_000));
    let preview = composer.preview(120, 360);
    assert_eq!(preview.width(), 120);
    assert_eq!(preview.height(), 360);
}

#[test]
fn session_options_reject_unknown_method() {
    let mut request = ScrollCaptureRequest::new(0, 0, 300, 400);
    request.method = Some("not-a-scroll-method".into());
    assert!(SessionOptions::from_request(&request).is_err());
}

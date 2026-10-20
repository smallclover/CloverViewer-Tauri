//! Conservative OCR inputs: preserve antialiasing and bound the engine bitmap size.
use image::{imageops::FilterType, DynamicImage, GenericImageView, Rgba, RgbaImage};

fn cjk(ch: char) -> bool {
    matches!(ch as u32, 0x3000..=0x30ff | 0x3400..=0x9fff | 0xf900..=0xfaff | 0xff01..=0xff60 | 0x20000..=0x3134f)
}

/// Windows inserts spaces between OCR words, including individual CJK characters.
/// Use actual word gaps to retain intentional spacing and all Latin word boundaries.
pub fn join_words(words: &[(String, f32, f32)]) -> String {
    let mut result = String::new();
    let mut previous: Option<&(String, f32, f32)> = None;
    for word in words {
        if word.0.is_empty() {
            continue;
        }
        if let Some(old) = previous {
            let gap = word.1 - (old.1 + old.2);
            let character_width = (old.2 / old.0.chars().count().max(1) as f32)
                .max(word.2 / word.0.chars().count().max(1) as f32);
            let touching_cjk =
                old.0.chars().last().is_some_and(cjk) && word.0.chars().next().is_some_and(cjk);
            if !touching_cjk || gap > character_width * 0.6 {
                result.push(' ');
            }
        }
        result.push_str(&word.0);
        previous = Some(word);
    }
    result
}

pub fn prepare(img: &DynamicImage, max_dimension: u32, enhance: bool) -> DynamicImage {
    let (w, h) = img.dimensions();
    let scale =
        (max_dimension as f64 / w.max(h).max(1) as f64).min(if enhance { 2.0 } else { 1.0 });
    let (w, h) = (
        (w as f64 * scale).round().max(1.0) as u32,
        (h as f64 * scale).round().max(1.0) as u32,
    );
    let source = img.to_rgba8();
    let opaque = RgbaImage::from_fn(source.width(), source.height(), |x, y| {
        let p = source.get_pixel(x, y);
        let alpha = p[3] as u32;
        let channel = |c: u8| ((c as u32 * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        Rgba([channel(p[0]), channel(p[1]), channel(p[2]), 255])
    });
    let result = DynamicImage::ImageRgba8(if opaque.dimensions() == (w, h) {
        opaque
    } else {
        image::imageops::resize(&opaque, w, h, FilterType::Lanczos3)
    });
    if !enhance {
        return result;
    }
    let mut gray = result.into_luma8();
    let mean = gray.pixels().map(|p| p[0] as u64).sum::<u64>() as f64 / (w as f64 * h as f64);
    if mean < 120.0 {
        image::imageops::invert(&mut gray);
    }
    DynamicImage::ImageLuma8(gray)
}

/// Compare candidates with one common metric; a candidate's language cannot award itself points.
/// Text length is bounded so a long stream of junk cannot win solely by being longer.
pub fn text_score(text: &str, preferred: crate::config::Language) -> f64 {
    let mut meaningful = 0usize;
    let mut kana = 0usize;
    let mut junk = 0usize;
    let mut punctuation = 0usize;
    for ch in text.chars().filter(|c| !c.is_whitespace()) {
        if ch == '\u{fffd}' || ch.is_control() {
            junk += 1;
        } else if ch.is_alphanumeric() {
            meaningful += 1;
        } else {
            punctuation += 1;
        }
        if ('\u{3041}'..='\u{3096}').contains(&ch) || ('\u{30a1}'..='\u{30fa}').contains(&ch) {
            kana += 1;
        }
    }
    if meaningful == 0 {
        return if punctuation > 0 && junk == 0 {
            0.1
        } else {
            -100.0
        };
    }
    let ratio = meaningful as f64 / (meaningful + punctuation + junk) as f64;
    let script = if preferred == crate::config::Language::Ja && kana > 0 {
        0.2
    } else {
        0.0
    };
    ratio + (meaningful.min(40) as f64).ln_1p() * 0.06 + script - junk as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Language;
    #[test]
    fn cjk_spacing_uses_geometry_without_merging_english_words() {
        let words = vec![
            ("中".into(), 0., 12.),
            ("文".into(), 14., 12.),
            ("English".into(), 35., 50.),
            ("OCR".into(), 95., 25.),
            ("日".into(), 130., 12.),
            ("本".into(), 144., 12.),
            ("語".into(), 158., 12.),
        ];
        assert_eq!(join_words(&words), "中文 English OCR 日本語");
        assert_eq!(
            join_words(&[("氏名".into(), 0., 24.), ("住所".into(), 60., 24.)]),
            "氏名 住所"
        );
    }
    #[test]
    fn short_multilingual_results_are_valid() {
        for (text, lang) in [
            ("确定", Language::Zh),
            ("OK", Language::En),
            ("設定", Language::Ja),
            ("あ", Language::Ja),
            ("7", Language::En),
        ] {
            assert!(text_score(text, lang) > text_score("", lang));
            assert!(text_score(text, lang) > text_score("~|_?~|_?~~~", lang));
        }
        assert!(text_score("设置", Language::Zh) > text_score("设置�abc", Language::Zh));
    }
    #[test]
    fn originals_keep_gray_edges_and_transparency_is_composited() {
        let img = DynamicImage::ImageRgba8(RgbaImage::from_fn(4, 2, |x, _| {
            if x == 0 {
                Rgba([0, 0, 0, 0])
            } else {
                Rgba([92, 130, 185, 255])
            }
        }));
        let output = prepare(&img, 4096, false).into_rgba8();
        assert_eq!(output.get_pixel(0, 0).0, [255, 255, 255, 255]);
        assert_eq!(output.get_pixel(1, 0).0, [92, 130, 185, 255]);
        assert_eq!(prepare(&img, 3, true).width(), 3);
    }
}

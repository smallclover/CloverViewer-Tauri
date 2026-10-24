//! System OCR stays dependency-free at runtime; Paddle assets are entirely opt-in.
mod assets;
pub(crate) mod models;
mod paddle;
mod processing;
pub mod result;
use result::OcrDocument;
mod worker;

use crate::config::{Language, OcrEngine, OcrLanguage};
use base64::Engine;
use image::DynamicImage;

pub fn decode_png(b64: &str) -> Result<DynamicImage, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| e.to_string())?;
    image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).map_err(|e| e.to_string())
}

/// MCP uses the saved engine; its explicit language overrides the OCR preference.
pub fn recognize_text(img: DynamicImage, language: Option<Language>) -> Result<String, String> {
    let config = crate::config::load_config();
    let language = language
        .map(|lang| match lang {
            Language::Zh => OcrLanguage::Zh,
            Language::En => OcrLanguage::En,
            Language::Ja => OcrLanguage::Ja,
        })
        .unwrap_or(config.ocr_language);
    recognize(img, config.ocr_engine, language, config.language).map(|result| result.text)
}

fn recognize(
    img: DynamicImage,
    engine: OcrEngine,
    language: OcrLanguage,
    ui: Language,
) -> Result<OcrDocument, String> {
    if engine == OcrEngine::Paddle {
        return worker::recognize(img);
    }
    #[cfg(windows)]
    {
        system::recognize(&img, language, ui)
    }
    #[cfg(not(windows))]
    {
        let _ = (img, language, ui);
        Err("OCR_UNSUPPORTED".into())
    }
}

pub fn run_worker() {
    worker::run();
}

#[cfg(all(test, windows))]
mod real_tests {
    use super::*;
    #[test]
    #[ignore = "requires CLOVER_OCR_TEST_IMAGE; optional installed Paddle assets"]
    fn structured_input_sample() {
        let image = image::open(std::env::var_os("CLOVER_OCR_TEST_IMAGE").unwrap()).unwrap();
        let system = system::recognize(&image, OcrLanguage::Auto, Language::Zh).unwrap();
        system.validate().unwrap();
        assert_eq!(system.image_width, image.width());
        assert_eq!(system.image_height, image.height());
        assert!(!system.lines.is_empty());
        assert!(system
            .lines
            .iter()
            .all(|line| line.quad[2].x > line.quad[0].x && line.quad[2].y > line.quad[0].y));
        if let Some(output) = std::env::var_os("CLOVER_OCR_TEST_OUTPUT") {
            std::fs::write(output, serde_json::to_vec(&system).unwrap()).unwrap();
        }
        println!(
            "System: {} lines, {} text bytes",
            system.lines.len(),
            system.text.len()
        );
        let directory = models::directory().unwrap();
        if models::installed_at(&directory) {
            let paddle = paddle::recognize(image, &directory).unwrap();
            paddle.validate().unwrap();
            assert!(!paddle.lines.is_empty());
            assert_eq!(paddle.image_width, system.image_width);
            assert_eq!(paddle.image_height, system.image_height);
            println!(
                "Paddle: {} lines, {} text bytes",
                paddle.lines.len(),
                paddle.text.len()
            );
        }
    }
    #[test]
    #[ignore = "requires CLOVER_OCR_TEST_IMAGES and installed Windows OCR language packs"]
    fn system_multilingual_samples() {
        let images = std::path::PathBuf::from(std::env::var_os("CLOVER_OCR_TEST_IMAGES").unwrap());
        for (file, lang, expected) in [
            ("en.png", OcrLanguage::En, "CloverViewerOCR2026"),
            ("zh.png", OcrLanguage::Zh, "中文识别测试"),
            ("ja.png", OcrLanguage::Ja, "日本語の文字認識"),
            ("short.png", OcrLanguage::Zh, "确定"),
            ("dark.png", OcrLanguage::En, "DarkmodeOCR2026"),
        ] {
            let image = image::open(images.join(file)).unwrap();
            let text = match system::recognize(&image, lang, Language::Zh).map(|result| result.text)
            {
                Ok(text) => text,
                Err(e) if e == "OCR_LANGUAGE_UNAVAILABLE" => {
                    println!("{file}: language pack unavailable");
                    continue;
                }
                Err(e) => panic!("{file}: {e}"),
            };
            println!("system {file}: {text}");
            let normalized: String = text.chars().filter(|c| !c.is_whitespace()).collect();
            assert!(
                normalized.contains(expected),
                "{file}: expected {expected}, got {text}"
            );
        }
    }
}

#[tauri::command]
pub async fn ocr_image(app: tauri::AppHandle, png: String) -> Result<String, String> {
    use tauri::Manager;
    let config = app.state::<crate::config::ConfigStore>().snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        recognize(
            decode_png(&png)?,
            config.ocr_engine,
            config.ocr_language,
            config.language,
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|result| result.text)
}

#[tauri::command]
pub async fn ocr_image_document(app: tauri::AppHandle, png: String) -> Result<OcrDocument, String> {
    use tauri::Manager;
    let config = app.state::<crate::config::ConfigStore>().snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        recognize(
            decode_png(&png)?,
            config.ocr_engine,
            config.ocr_language,
            config.language,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
mod system {
    use super::*;
    use std::future::IntoFuture;
    use windows::{
        core::HSTRING,
        Globalization::Language as WinLanguage,
        Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
        Security::Cryptography::CryptographicBuffer,
    };

    pub fn recognize(
        img: &DynamicImage,
        language: OcrLanguage,
        ui: Language,
    ) -> Result<OcrDocument, String> {
        let preferred = language.preferred(ui);
        let mut engines = Vec::new();
        let mut add = |lang: Language| {
            let tag = match lang {
                Language::Zh => "zh-Hans",
                Language::En => "en",
                Language::Ja => "ja",
            };
            if let Ok(win_lang) = WinLanguage::CreateLanguage(&HSTRING::from(tag)) {
                if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&win_lang) {
                    engines.push(engine);
                }
            }
        };
        add(preferred);
        if language == OcrLanguage::Auto {
            for lang in [Language::Zh, Language::En, Language::Ja] {
                if lang != preferred {
                    add(lang);
                }
            }
            if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
                engines.push(engine);
            }
        }
        if engines.is_empty() {
            return Err("OCR_LANGUAGE_UNAVAILABLE".into());
        }
        let max = OcrEngine::MaxImageDimension().map_err(|e| e.to_string())?;
        let mut last_error = None;
        // First pass preserves color/antialiasing. Enhancement only recovers empty results.
        for enhance in [false, true] {
            let rgba = processing::prepare(img, max, enhance).into_rgba8();
            let buffer = CryptographicBuffer::CreateFromByteArray(rgba.as_raw())
                .map_err(|e| e.to_string())?;
            let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
                &buffer,
                BitmapPixelFormat::Rgba8,
                rgba.width() as i32,
                rgba.height() as i32,
            )
            .map_err(|e| e.to_string())?;
            let mut best: Option<(f64, OcrDocument)> = None;
            for engine in &engines {
                let result = (|| -> windows::core::Result<Vec<result::OcrLine>> {
                    let result = pollster::block_on(engine.RecognizeAsync(&bitmap)?.into_future())?;
                    let mut lines = Vec::new();
                    for line in result.Lines()? {
                        let mut words = Vec::new();
                        let mut area = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
                        for word in line.Words()? {
                            let bounds = word.BoundingRect()?;
                            words.push((word.Text()?.to_string(), bounds.X, bounds.Width));
                            area = [
                                area[0].min(bounds.X),
                                area[1].min(bounds.Y),
                                area[2].max(bounds.X + bounds.Width),
                                area[3].max(bounds.Y + bounds.Height),
                            ];
                        }
                        if !words.is_empty() {
                            let sx = img.width() as f32 / rgba.width() as f32;
                            let sy = img.height() as f32 / rgba.height() as f32;
                            let [x, y, right, bottom] = area;
                            lines.push(result::line(
                                processing::join_words(&words),
                                [
                                    (x * sx, y * sy),
                                    (right * sx, y * sy),
                                    (right * sx, bottom * sy),
                                    (x * sx, bottom * sy),
                                ],
                                None,
                            ));
                        }
                    }
                    Ok(lines)
                })();
                let result = result
                    .map_err(|e| e.to_string())
                    .and_then(|lines| OcrDocument::new(img.width(), img.height(), lines));
                match result {
                    Ok(document) if !document.text.trim().is_empty() => {
                        let score = processing::text_score(&document.text, preferred);
                        if score > -1.0 && best.as_ref().is_none_or(|(old, _)| score > *old + 0.03)
                        {
                            best = Some((score, document));
                        }
                    }
                    Ok(_) => {}
                    Err(error) => last_error = Some(error.to_string()),
                }
            }
            if let Some((_, text)) = best {
                return Ok(text);
            }
        }
        if let Some(error) = last_error {
            Err(error)
        } else {
            OcrDocument::new(img.width(), img.height(), Vec::new())
        }
    }
}

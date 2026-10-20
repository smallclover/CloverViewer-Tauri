//! System OCR stays dependency-free at runtime; Paddle assets are entirely opt-in.
mod assets;
pub(crate) mod models;
mod paddle;
mod processing;
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
    recognize(img, config.ocr_engine, language, config.language)
}

fn recognize(
    img: DynamicImage,
    engine: OcrEngine,
    language: OcrLanguage,
    ui: Language,
) -> Result<String, String> {
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
            let text = match system::recognize(&image, lang, Language::Zh) {
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
    ) -> Result<String, String> {
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
            let mut best: Option<(f64, String)> = None;
            for engine in &engines {
                let result = (|| -> windows::core::Result<String> {
                    let result = pollster::block_on(engine.RecognizeAsync(&bitmap)?.into_future())?;
                    let mut lines = Vec::new();
                    for line in result.Lines()? {
                        let mut words = Vec::new();
                        for word in line.Words()? {
                            let bounds = word.BoundingRect()?;
                            words.push((word.Text()?.to_string(), bounds.X, bounds.Width));
                        }
                        lines.push(processing::join_words(&words));
                    }
                    Ok(lines.join("\n"))
                })();
                match result {
                    Ok(text) if !text.trim().is_empty() => {
                        let score = processing::text_score(&text, preferred);
                        if score > -1.0 && best.as_ref().is_none_or(|(old, _)| score > *old + 0.03)
                        {
                            best = Some((score, text));
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
            Ok(String::new())
        }
    }
}

//! Run downloaded native code in a short-lived child: no DLL remains locked in the GUI process.
use super::result::{OcrDocument, MAX_RESULT_BYTES};
use image::DynamicImage;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub fn recognize(img: DynamicImage) -> Result<OcrDocument, String> {
    if img.width() as u64 * img.height() as u64 > 60_000_000 {
        return Err("OCR_INPUT_TOO_LARGE".into());
    }
    if !super::models::SUPPORTED {
        return Err("OCR_UNSUPPORTED".into());
    }
    let _access = super::models::ACCESS
        .try_read()
        .map_err(|_| "OCR_MODEL_BUSY".to_string())?;
    let directory = super::models::directory()?;
    if !super::models::installed_at(&directory) {
        return Err("OCR_MODEL_MISSING".into());
    }
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    if png.get_ref().len() > 64 * 1024 * 1024 {
        return Err("OCR_INPUT_TOO_LARGE".into());
    }
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command
        .arg("--ocr-worker")
        .arg(&directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("OCR_WORKER_FAILED")?;
    let mut stdin = child.stdin.take().ok_or("OCR_WORKER_FAILED")?;
    let outcome = std::thread::scope(|scope| {
        // Drain stdout concurrently; a large text result must not fill the pipe and deadlock.
        let reader = scope.spawn(move || {
            let mut output = Vec::new();
            stdout
                .by_ref()
                .take(MAX_RESULT_BYTES as u64 + 1)
                .read_to_end(&mut output)?;
            std::io::copy(&mut stdout, &mut std::io::sink())?;
            Ok::<_, std::io::Error>(output)
        });
        let writer = scope.spawn(move || stdin.write_all(png.get_ref()));
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err("OCR_WORKER_FAILED".into());
                    }
                    break;
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(30))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("OCR_WORKER_FAILED".into());
                }
            }
        }
        writer
            .join()
            .map_err(|_| "OCR_WORKER_FAILED")?
            .map_err(|e| e.to_string())?;
        let output = reader
            .join()
            .map_err(|_| "OCR_WORKER_FAILED")?
            .map_err(|e| e.to_string())?;
        if output.len() > MAX_RESULT_BYTES {
            return Err("OCR_RESULT_TOO_LARGE".into());
        }
        let document = serde_json::from_slice::<Result<OcrDocument, String>>(&output)
            .map_err(|_| "OCR_WORKER_FAILED".to_string())??;
        document.validate()?;
        Ok(document)
    });
    // Also reap on early pipe/parse failure.
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

pub fn run() {
    let result = (|| -> Result<OcrDocument, String> {
        let directory = std::env::args_os()
            .nth(2)
            .map(std::path::PathBuf::from)
            .ok_or("OCR_MODEL_MISSING")?;
        let mut input = Vec::new();
        std::io::stdin()
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut input)
            .map_err(|e| e.to_string())?;
        if input.len() > 64 * 1024 * 1024 {
            return Err("OCR_INPUT_TOO_LARGE".into());
        }
        let img = image::load_from_memory_with_format(&input, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        if img.width() as u64 * img.height() as u64 > 60_000_000 {
            return Err("OCR_INPUT_TOO_LARGE".into());
        }
        super::paddle::recognize(img, &directory)
    })();
    let result = result.and_then(|document| {
        document.validate()?;
        Ok(document)
    });
    if let Ok(json) = serde_json::to_string(&result) {
        let _ = std::io::stdout().write_all(json.as_bytes());
    }
}

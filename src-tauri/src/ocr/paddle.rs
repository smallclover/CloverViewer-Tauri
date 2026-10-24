//! PP-OCRv5 DB detection + perspective rectification + CTC recognition, CPU only.
use super::result::{self, OcrDocument};
use image::{
    imageops::{self, FilterType},
    DynamicImage, GrayImage, Luma, Rgb, RgbImage,
};
use imageproc::{
    contours::{find_contours, BorderType},
    geometry::min_area_rect,
};
use ort::{session::Session, value::Tensor};
use std::path::Path;

type Point = (f32, f32);
#[derive(Clone, Debug)]
struct TextBox {
    corners: [Point; 4],
    score: f32,
}
impl TextBox {
    fn bounds(&self) -> [f32; 4] {
        self.corners
            .iter()
            .fold([f32::MAX, f32::MAX, f32::MIN, f32::MIN], |b, &(x, y)| {
                [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)]
            })
    }
}
fn distance(a: Point, b: Point) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn session(path: &Path) -> Result<Session, String> {
    Session::builder()
        .and_then(|b| b.with_intra_threads(2))
        .and_then(|b| b.commit_from_file(path))
        .map_err(|e| e.to_string())
}

pub fn recognize(img: DynamicImage, directory: &Path) -> Result<OcrDocument, String> {
    super::assets::verify(directory)?;
    ort::init_from(directory.join("onnxruntime.dll").to_string_lossy())
        .commit()
        .map_err(|e| e.to_string())?;
    let mut detector = session(&directory.join("det.onnx"))?;
    let mut recognizer = session(&directory.join("rec.onnx"))?;
    // The dictionary is embedded in this pinned ONNX model, including Japanese kana.
    let dictionary = recognizer
        .metadata()
        .and_then(|m| m.custom("character"))
        .map_err(|e| e.to_string())?
        .ok_or("OCR_MODEL_CORRUPT")?;
    let mut characters = vec![String::new()];
    characters.extend(dictionary.lines().map(String::from));
    characters.push(" ".into());
    let source = super::processing::prepare(&img, img.width().max(img.height()), false).into_rgb8();
    let mut boxes: Vec<TextBox> = Vec::new();
    // Tile large screenshots rather than shrinking a long page's text to a few pixels.
    for y in (0..source.height()).step_by(1152) {
        for x in (0..source.width()).step_by(1920) {
            let tile = imageops::crop_imm(
                &source,
                x,
                y,
                (source.width() - x).min(2048),
                (source.height() - y).min(1280),
            )
            .to_image();
            for mut b in detect(&mut detector, &tile)? {
                for p in &mut b.corners {
                    p.0 += x as f32;
                    p.1 += y as f32;
                }
                if let Some(old) = boxes
                    .iter_mut()
                    .find(|old| overlap(old.bounds(), b.bounds()) > 0.45)
                {
                    if b.score > old.score {
                        *old = b;
                    }
                } else {
                    boxes.push(b);
                }
            }
        }
    }
    boxes.sort_by(|a, b| {
        a.bounds()[1]
            .total_cmp(&b.bounds()[1])
            .then(a.bounds()[0].total_cmp(&b.bounds()[0]))
    });
    // Reorder boxes within a visual line; don't use a non-transitive fuzzy sort comparator.
    let mut start = 0;
    while start < boxes.len() {
        let bounds = boxes[start].bounds();
        let tolerance = ((bounds[3] - bounds[1]) * 0.5).clamp(3.0, 20.0);
        let end = (start + 1..boxes.len())
            .find(|&i| boxes[i].bounds()[1] - bounds[1] > tolerance)
            .unwrap_or(boxes.len());
        boxes[start..end].sort_by(|a, b| a.bounds()[0].total_cmp(&b.bounds()[0]));
        start = end;
    }
    if boxes.len() > result::MAX_LINES {
        return Err("OCR_RESULT_TOO_LARGE".into());
    }
    let mut text = Vec::new();
    for b in boxes {
        let crop = rectify(&source, &b);
        let (line, confidence) = read_line(&mut recognizer, &crop, &characters)?;
        if confidence >= 0.5 && !line.trim().is_empty() {
            text.push(result::line(line, b.corners, Some(confidence)));
        }
    }
    OcrDocument::new(img.width(), img.height(), text)
}

fn overlap(a: [f32; 4], b: [f32; 4]) -> f32 {
    let intersection =
        (a[2].min(b[2]) - a[0].max(b[0])).max(0.0) * (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    intersection
        / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection).max(1.0)
}

fn detect(session: &mut Session, source: &RgbImage) -> Result<Vec<TextBox>, String> {
    let scale = (1280.0 / source.width().max(source.height()) as f32).min(1.0);
    let w = ((source.width() as f32 * scale / 32.0).round().max(1.0) as u32) * 32;
    let h = ((source.height() as f32 * scale / 32.0).round().max(1.0) as u32) * 32;
    let resized = imageops::resize(source, w, h, FilterType::Triangle);
    let plane = (w * h) as usize;
    let mut data = vec![0f32; plane * 3];
    // Models use OpenCV BGR channel order with ImageNet normalization.
    for (i, pixel) in resized.pixels().enumerate() {
        for c in 0..3 {
            data[c * plane + i] =
                (pixel[2 - c] as f32 / 255.0 - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c];
        }
    }
    let tensor = Tensor::from_array(([1usize, 3, h as usize, w as usize], data))
        .map_err(|e| e.to_string())?;
    let result = session
        .run(ort::inputs![tensor])
        .map_err(|e| e.to_string())?;
    let (shape, map) = result[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    if shape.len() != 4 || shape[2] <= 0 || shape[3] <= 0 {
        return Err("OCR_MODEL_CORRUPT".into());
    }
    let (mh, mw) = (shape[2] as u32, shape[3] as u32);
    if map.len() != (mw * mh) as usize {
        return Err("OCR_MODEL_CORRUPT".into());
    }
    let binary = GrayImage::from_fn(mw, mh, |x, y| {
        Luma([if map[(y * mw + x) as usize] > 0.3 {
            255
        } else {
            0
        }])
    });
    let mut boxes = Vec::new();
    for contour in find_contours::<i32>(&binary).into_iter().take(10000) {
        if contour.border_type != BorderType::Outer || contour.points.len() < 3 {
            continue;
        }
        let points = min_area_rect(&contour.points);
        let mut corners = points.map(|p| (p.x as f32, p.y as f32));
        corners.sort_by(|a, b| a.0.total_cmp(&b.0));
        if corners[0].1 > corners[1].1 {
            corners.swap(0, 1);
        }
        if corners[2].1 > corners[3].1 {
            corners.swap(2, 3);
        }
        corners.swap(2, 3); // TL, BL, BR, TR
        corners.swap(1, 3); // TL, TR, BR, BL
        let (bw, bh) = (
            distance(corners[0], corners[1]),
            distance(corners[0], corners[3]),
        );
        if bw.min(bh) < 3.0 {
            continue;
        }
        let bounds = TextBox {
            corners,
            score: 0.0,
        }
        .bounds();
        let mut sum = 0.0;
        let mut count = 0;
        for y in (bounds[1].max(0.0) as u32)..=(bounds[3] as u32).min(mh - 1) {
            for x in (bounds[0].max(0.0) as u32)..=(bounds[2] as u32).min(mw - 1) {
                if inside((x as f32, y as f32), &corners) {
                    sum += map[(y * mw + x) as usize];
                    count += 1;
                }
            }
        }
        let score = sum / (count as f32).max(1.0);
        if score < 0.55 {
            continue;
        }
        let margin = bw * bh * 1.5 / (2.0 * (bw + bh));
        let center = (
            (corners[0].0 + corners[2].0) / 2.0,
            (corners[0].1 + corners[2].1) / 2.0,
        );
        let ux = (
            (corners[1].0 - corners[0].0) / bw,
            (corners[1].1 - corners[0].1) / bw,
        );
        let uy = (
            (corners[3].0 - corners[0].0) / bh,
            (corners[3].1 - corners[0].1) / bh,
        );
        for (i, (sx, sy)) in [(-1., -1.), (1., -1.), (1., 1.), (-1., 1.)]
            .into_iter()
            .enumerate()
        {
            corners[i] = (
                (center.0 + sx * ux.0 * (bw / 2. + margin) + sy * uy.0 * (bh / 2. + margin))
                    * source.width() as f32
                    / mw as f32,
                (center.1 + sx * ux.1 * (bw / 2. + margin) + sy * uy.1 * (bh / 2. + margin))
                    * source.height() as f32
                    / mh as f32,
            );
        }
        boxes.push(TextBox { corners, score });
    }
    Ok(boxes)
}

fn inside(p: Point, corners: &[Point; 4]) -> bool {
    (0..4).all(|i| {
        let a = corners[i];
        let b = corners[(i + 1) % 4];
        (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0) >= -0.01
    })
}

fn rectify(source: &RgbImage, b: &TextBox) -> RgbImage {
    let p = b.corners;
    let w = distance(p[0], p[1]).round().clamp(1., 8192.) as u32;
    let h = distance(p[0], p[3]).round().clamp(1., 2048.) as u32;
    let mut crop = RgbImage::new(w, h);
    imageproc::geometric_transformations::warp_into_with(
        source,
        |x, y| {
            let u = x / w.max(1) as f32;
            let v = y / h.max(1) as f32;
            let sx = p[0].0 + u * (p[1].0 - p[0].0) + v * (p[3].0 - p[0].0);
            let sy = p[0].1 + u * (p[1].1 - p[0].1) + v * (p[3].1 - p[0].1);
            (sx, sy)
        },
        imageproc::geometric_transformations::Interpolation::Bilinear,
        imageproc::geometric_transformations::Border::Constant(Rgb([255; 3])),
        &mut crop,
    );
    if h as f32 / w as f32 > 1.5 {
        imageops::rotate270(&crop)
    } else {
        crop
    }
}

fn read_line(
    session: &mut Session,
    source: &RgbImage,
    characters: &[String],
) -> Result<(String, f32), String> {
    let w = (48.0 * source.width() as f32 / source.height().max(1) as f32)
        .ceil()
        .clamp(16., 4096.) as u32;
    let resized = imageops::resize(source, w, 48, FilterType::Triangle);
    let plane = (w * 48) as usize;
    let mut data = vec![0f32; plane * 3];
    for (i, pixel) in resized.pixels().enumerate() {
        for c in 0..3 {
            data[c * plane + i] = (pixel[2 - c] as f32 / 255.0 - 0.5) / 0.5;
        }
    }
    let tensor =
        Tensor::from_array(([1usize, 3, 48, w as usize], data)).map_err(|e| e.to_string())?;
    let output = session
        .run(ort::inputs![tensor])
        .map_err(|e| e.to_string())?;
    let (shape, probs) = output[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    if shape.len() != 3 || shape[0] != 1 || shape[2] as usize != characters.len() {
        return Err("OCR_MODEL_CORRUPT".into());
    }
    Ok(decode(probs, characters))
}

fn decode(probs: &[f32], characters: &[String]) -> (String, f32) {
    let mut text = String::new();
    let mut previous = 0;
    let mut sum = 0.;
    let mut count = 0;
    for step in probs.chunks_exact(characters.len()) {
        let (index, &probability) = step
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap();
        if index != 0 && index != previous {
            text.push_str(&characters[index]);
            sum += probability;
            count += 1;
        }
        previous = index;
    }
    (text, sum / (count as f32).max(1.))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires CLOVER_OCR_TEST_ASSETS and CLOVER_OCR_TEST_IMAGES"]
    fn real_multilingual_models() {
        let directory =
            std::path::PathBuf::from(std::env::var_os("CLOVER_OCR_TEST_ASSETS").unwrap());
        let images = std::path::PathBuf::from(std::env::var_os("CLOVER_OCR_TEST_IMAGES").unwrap());
        for (file, expected) in [
            ("en.png", "CloverViewerOCR2026"),
            ("zh.png", "中文识别测试"),
            ("ja.png", "日本語の文字認識"),
            ("short.png", "确定"),
            ("dark.png", "DarkmodeOCR2026"),
        ] {
            let text = recognize(image::open(images.join(file)).unwrap(), &directory)
                .unwrap()
                .text;
            println!("{file}: {text}");
            let normalized: String = text.chars().filter(|c| !c.is_whitespace()).collect();
            assert!(
                normalized.contains(expected),
                "{file}: expected {expected}, got {text}"
            );
        }
    }
    #[test]
    fn ctc_preserves_repeated_letters_after_blank_and_all_three_scripts() {
        let chars = ["", "中", "あ", "A"].map(String::from);
        let indices = [1, 1, 0, 1, 2, 2, 3, 0, 3];
        let probabilities = indices
            .iter()
            .flat_map(|&i| (0..4).map(move |j| if i == j { 0.9 } else { 0.01 }))
            .collect::<Vec<_>>();
        assert_eq!(decode(&probabilities, &chars).0, "中中あAA");
    }
    #[test]
    fn rectified_horizontal_line_keeps_its_orientation() {
        let image = RgbImage::from_fn(30, 20, |x, _| Rgb([x as u8, 0, 0]));
        let b = TextBox {
            corners: [(2., 3.), (22., 3.), (22., 13.), (2., 13.)],
            score: 1.,
        };
        let crop = rectify(&image, &b);
        assert_eq!(crop.dimensions(), (20, 10));
        assert!(crop.get_pixel(18, 5)[0] > crop.get_pixel(1, 5)[0]);
    }
}

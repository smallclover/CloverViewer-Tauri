//! Coordinates always refer to the exact input bitmap, before engine preprocessing.
use serde::{Deserialize, Serialize};

pub const MAX_RESULT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_LINES: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrLine {
    pub id: String,
    pub text: String,
    pub quad: [Point; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrDocument {
    pub version: u8,
    pub image_width: u32,
    pub image_height: u32,
    pub text: String,
    pub lines: Vec<OcrLine>,
}

impl OcrDocument {
    pub fn new(width: u32, height: u32, mut lines: Vec<OcrLine>) -> Result<Self, String> {
        for (index, line) in lines.iter_mut().enumerate() {
            line.id = format!("line-{index}");
            for point in &mut line.quad {
                point.x = point.x.clamp(0., width as f32);
                point.y = point.y.clamp(0., height as f32);
            }
        }
        let document = Self {
            version: 1,
            image_width: width,
            image_height: height,
            text: lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            lines,
        };
        document.validate()?;
        Ok(document)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.image_width == 0
            || self.image_height == 0
            || self.lines.len() > MAX_LINES
            || self.lines.iter().any(|line| {
                line.quad.iter().any(|p| {
                    !p.x.is_finite()
                        || !p.y.is_finite()
                        || p.x < 0.
                        || p.y < 0.
                        || p.x > self.image_width as f32
                        || p.y > self.image_height as f32
                })
            })
        {
            return Err("OCR_RESULT_INVALID".into());
        }
        let size = serde_json::to_vec(self).map_err(|e| e.to_string())?.len();
        if size > MAX_RESULT_BYTES {
            return Err("OCR_RESULT_TOO_LARGE".into());
        }
        Ok(())
    }
}

pub fn line(text: String, corners: [(f32, f32); 4], confidence: Option<f32>) -> OcrLine {
    OcrLine {
        id: String::new(),
        text,
        quad: corners.map(|(x, y)| Point { x, y }),
        confidence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_coordinates_and_text_survive_serialization() {
        let result = OcrDocument::new(
            100,
            80,
            vec![line(
                "中文\nEnglish".into(),
                [(-2., 3.), (103., 3.), (103., 20.), (-2., 20.)],
                None,
            )],
        )
        .unwrap();
        assert_eq!(result.lines[0].quad[0].x, 0.);
        assert_eq!(result.lines[0].quad[1].x, 100.);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("imageWidth"));
        let restored: OcrDocument = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.text, "中文\nEnglish");
        assert_eq!(restored.lines[0].id, "line-0");
    }
    #[test]
    fn invalid_coordinates_are_rejected() {
        assert!(
            OcrDocument::new(10, 10, vec![line("x".into(), [(f32::NAN, 0.); 4], None)]).is_err()
        );
    }
}

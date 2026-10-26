use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub schema: u32,
    pub revision: u64,
    pub auto_apply: bool,
    pub default_preset_id: String,
    pub last_preset_id: String,
    pub presets: Vec<Preset>,
}

impl Default for Library {
    fn default() -> Self {
        Self {
            schema: 3,
            revision: 0,
            auto_apply: false,
            default_preset_id: "mac-light".into(),
            last_preset_id: "mac-light".into(),
            presets: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub document: Document,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub enabled: bool,
    pub reference_size: f64,
    pub frame: Frame,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<Background>,
    pub watermarks: Vec<Watermark>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditContext {
    pub document: Document,
    pub captured_at: u64,
}

impl EditContext {
    pub fn validate(&self) -> Result<(), String> {
        if !self.document.valid() || self.captured_at > 253_402_300_799_999 {
            return Err("beautify.invalidLibrary".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub kind: String,
    pub padding: [f64; 4],
    pub border_width: f64,
    pub border_color: String,
    pub background: String,
    pub background_end: String,
    pub angle: f64,
    pub radius: f64,
    pub shadow: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<FrameStyle>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Background {
    pub kind: String,
    pub color: String,
    pub end_color: String,
    pub angle: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameStyle {
    pub title: String,
    pub url: String,
    pub compact: bool,
    pub title_bar_height: f64,
    pub rail_width: f64,
    pub mat_width: f64,
    pub mat_color: String,
    pub inner_width: f64,
    pub accent_color: String,
    pub paper_bottom: f64,
    pub caption: String,
    pub caption_date: bool,
}

const BUILTIN_IDS: &[&str] = &[
    "clean",
    "gradient",
    "brand",
    "marked",
    "mac-light",
    "mac-dark",
    "browser",
    "gallery",
    "wood",
    "polaroid",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watermark {
    pub id: String,
    pub kind: String,
    pub enabled: bool,
    pub text: String,
    pub asset_id: String,
    pub font: String,
    pub font_size: f64,
    pub color: String,
    pub opacity: f64,
    pub outline: f64,
    pub rotation: f64,
    pub placement: String,
    pub region: String,
    pub anchor: u8,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub gap_x: f64,
    pub gap_y: f64,
}

pub fn asset_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(super) fn color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}
pub(super) fn range(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

impl Library {
    pub fn migrate(&mut self) {
        if self.schema == 2 {
            self.schema = 3;
            return;
        }
        if self.schema != 1 {
            return;
        }
        for preset in &mut self.presets {
            let document = &mut preset.document;
            let frame = &mut document.frame;
            if frame.kind == "solid" || frame.kind == "gradient" {
                document.background = Some(Background {
                    kind: frame.kind.clone(),
                    color: frame.background.clone(),
                    end_color: frame.background_end.clone(),
                    angle: frame.angle,
                });
                frame.kind = "card".into();
            }
        }
        self.schema = 3;
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != 3
            || self.presets.len() > 100
            || self.default_preset_id.len() > 80
            || self.last_preset_id.len() > 80
        {
            return Err("beautify.invalidLibrary".into());
        }
        let mut ids = std::collections::HashSet::new();
        for preset in &self.presets {
            if preset.id.is_empty()
                || preset.id.len() > 80
                || !ids.insert(&preset.id)
                || BUILTIN_IDS.contains(&preset.id.as_str())
                || preset.name.trim().is_empty()
                || preset.name.chars().count() > 80
                || !preset.document.valid()
            {
                return Err("beautify.invalidLibrary".into());
            }
        }
        for id in [&self.default_preset_id, &self.last_preset_id] {
            if !BUILTIN_IDS.contains(&id.as_str())
                && !self.presets.iter().any(|preset| preset.id == *id)
            {
                return Err("beautify.invalidLibrary".into());
            }
        }
        Ok(())
    }
}

impl Document {
    fn valid(&self) -> bool {
        let f = &self.frame;
        if !range(self.reference_size, 1.0, 32767.0)
            || self.watermarks.len() > 8
            || ![
                "none",
                "border",
                "solid",
                "gradient",
                "card",
                "mac-light",
                "mac-dark",
                "browser",
                "gallery",
                "wood",
                "polaroid",
            ]
            .contains(&f.kind.as_str())
            || !f.padding.iter().all(|n| range(*n, 0.0, 32767.0))
            || ![f.border_width, f.radius, f.shadow]
                .iter()
                .all(|n| range(*n, 0.0, 32767.0))
            || !range(f.angle, -360.0, 360.0)
            || !color(&f.border_color)
            || !color(&f.background)
            || !color(&f.background_end)
        {
            return false;
        }
        if let Some(background) = &self.background {
            if !["transparent", "solid", "gradient"].contains(&background.kind.as_str())
                || !color(&background.color)
                || !color(&background.end_color)
                || !range(background.angle, -360.0, 360.0)
            {
                return false;
            }
        }
        if let Some(style) = &f.style {
            if [&style.title, &style.url, &style.caption]
                .iter()
                .any(|s| s.chars().count() > 300)
                || !color(&style.mat_color)
                || !color(&style.accent_color)
                || ![
                    style.title_bar_height,
                    style.rail_width,
                    style.mat_width,
                    style.inner_width,
                    style.paper_bottom,
                ]
                .iter()
                .all(|n| range(*n, 0.0, 32767.0))
            {
                return false;
            }
        }
        let mut ids = std::collections::HashSet::new();
        self.watermarks.iter().all(|w| {
            !w.id.is_empty()
                && w.id.len() <= 80
                && ids.insert(&w.id)
                && ["text", "image"].contains(&w.kind.as_str())
                && (w.asset_id.is_empty() || asset_id(&w.asset_id))
                && w.text.chars().count() <= 2000
                && ["sans", "serif", "mono"].contains(&w.font.as_str())
                && color(&w.color)
                && range(w.font_size, 0.01, 32767.0)
                && range(w.width, 0.01, 32767.0)
                && range(w.opacity, 0.0, 1.0)
                && range(w.outline, 0.0, 32767.0)
                && range(w.rotation, -360.0, 360.0)
                && ["single", "tile"].contains(&w.placement.as_str())
                && ["content", "top", "right", "bottom", "left"].contains(&w.region.as_str())
                && w.anchor <= 8
                && [w.x, w.y].iter().all(|n| range(*n, -32767.0, 32767.0))
                && [w.gap_x, w.gap_y].iter().all(|n| range(*n, 0.0, 32767.0))
        })
    }
}

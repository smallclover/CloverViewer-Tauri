//! Platform-independent V2 capture state machine.

use image::RgbaImage;

use super::matching::{FrameRegistrar, Registration, RegistrationVerdict};
use super::preview::{encode_png, frame_data_url};
use super::stitching::Composer;

const PREVIEW_WIDTH: u32 = 120;
const PREVIEW_MAX_HEIGHT: u32 = 360;

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    Appended {
        shift: u32,
        added: u32,
        support: f32,
    },
    NoMotion,
    Reverse,
    StaticRegion {
        percent: u8,
    },
    Uncertain {
        reason: &'static str,
    },
}

pub(super) struct CaptureEngine {
    registrar: FrameRegistrar,
    composer: Composer,
    last: RgbaImage,
    accepted_frames: u32,
    uncertain_frames: u32,
}

impl CaptureEngine {
    pub(super) fn new(first: RgbaImage) -> Self {
        Self {
            composer: Composer::new(first.clone()),
            last: first,
            registrar: FrameRegistrar::default(),
            accepted_frames: 1,
            uncertain_frames: 0,
        }
    }

    pub(super) fn width(&self) -> u32 {
        self.composer.width()
    }
    pub(super) fn height(&self) -> u32 {
        self.composer.height()
    }
    pub(super) fn frames(&self) -> u32 {
        self.accepted_frames
    }
    pub(super) fn uncertain_frames(&self) -> u32 {
        self.uncertain_frames
    }
    pub(super) fn last_frame(&self) -> &RgbaImage {
        &self.last
    }

    pub(super) fn preview_data_url(&self) -> Option<String> {
        let preview = self.composer.preview(PREVIEW_WIDTH, PREVIEW_MAX_HEIGHT);
        let png = encode_png(&preview, true).ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png)
        ))
    }

    pub(super) fn verified_preview_data_url(&self) -> Option<String> {
        frame_data_url(&self.last)
    }

    pub(super) fn ingest(&mut self, current: RgbaImage) -> Result<EngineEvent, String> {
        match self.registrar.register(&self.last, &current) {
            RegistrationVerdict::Accepted(registration) => self.accept(current, registration),
            RegistrationVerdict::NoMotion => Ok(EngineEvent::NoMotion),
            RegistrationVerdict::Reverse => Ok(EngineEvent::Reverse),
            RegistrationVerdict::StaticRegion { percent } => {
                Ok(EngineEvent::StaticRegion { percent })
            }
            RegistrationVerdict::Uncertain { reason } => {
                self.uncertain_frames += 1;
                Ok(EngineEvent::Uncertain { reason })
            }
        }
    }

    fn accept(
        &mut self,
        current: RgbaImage,
        registration: Registration,
    ) -> Result<EngineEvent, String> {
        let added = self.composer.append(&current, registration)?;
        self.last = current;
        self.accepted_frames += 1;
        self.uncertain_frames = 0;
        Ok(EngineEvent::Appended {
            shift: registration.shift,
            added,
            support: registration.support,
        })
    }

    pub(super) fn finish(self) -> Result<RgbaImage, String> {
        self.composer.finish(&self.last)
    }
}

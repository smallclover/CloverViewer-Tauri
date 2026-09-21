//! Pixel-exact V2 composition. Every output pixel comes from a captured frame.

use super::matching::Registration;
use image::RgbaImage;

#[derive(Debug)]
pub(super) struct Composer {
    first: RgbaImage,
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    footer_height: u32,
    laid_out: bool,
}

impl Composer {
    pub(super) fn new(first: RgbaImage) -> Self {
        let (width, height) = first.dimensions();
        Self {
            pixels: first.as_raw().to_vec(),
            first,
            width,
            height,
            footer_height: 0,
            laid_out: false,
        }
    }
    pub(super) fn width(&self) -> u32 {
        self.width
    }
    pub(super) fn height(&self) -> u32 {
        self.height
    }

    /// Render a bounded, whole-canvas preview without first cloning the full
    /// long image.  The preview is intentionally an overview: it lets the
    /// user see that their verified content is continuously growing while the
    /// full-resolution pixels stay in the composer.
    pub(super) fn preview(&self, target_width: u32, max_height: u32) -> RgbaImage {
        let width = target_width.max(1);
        let proportional_height = ((self.height as u64 * width as u64)
            .saturating_add(self.width.max(1) as u64 - 1)
            / self.width.max(1) as u64) as u32;
        let height = proportional_height.clamp(1, max_height.max(1));
        let bytes_per_row = self.width as usize * 4;
        RgbaImage::from_fn(width, height, |x, y| {
            let source_x = ((x as u64 * self.width as u64) / width as u64)
                .min(self.width.saturating_sub(1) as u64) as usize;
            let source_y = ((y as u64 * self.height as u64) / height as u64)
                .min(self.height.saturating_sub(1) as u64) as usize;
            let offset = source_y * bytes_per_row + source_x * 4;
            image::Rgba([
                self.pixels[offset],
                self.pixels[offset + 1],
                self.pixels[offset + 2],
                self.pixels[offset + 3],
            ])
        })
    }
    pub(super) fn append(
        &mut self,
        current: &RgbaImage,
        registration: Registration,
    ) -> Result<u32, String> {
        if current.dimensions() != (self.width, self.first.height()) {
            return Err("captured frame dimensions changed".into());
        }
        let h = current.height();
        if !self.laid_out {
            self.footer_height = registration.bottom_fixed.min(h.saturating_sub(1));
            self.pixels
                .truncate((h - self.footer_height) as usize * self.width as usize * 4);
            self.height = h - self.footer_height;
            self.laid_out = true;
        }
        let end = h.saturating_sub(self.footer_height);
        let start = end
            .saturating_sub(registration.shift)
            .max(registration.top_fixed);
        if end <= start {
            return Err("registered frame has no new body pixels".into());
        }
        let bytes = self.width as usize * 4;
        self.pixels
            .extend_from_slice(&current.as_raw()[start as usize * bytes..end as usize * bytes]);
        let appended = end - start;
        self.height += appended;
        Ok(appended)
    }
    pub(super) fn finish(mut self, last: &RgbaImage) -> Result<RgbaImage, String> {
        if self.laid_out && self.footer_height > 0 {
            let bytes = self.width as usize * 4;
            let start = (last.height() - self.footer_height) as usize * bytes;
            self.pixels.extend_from_slice(&last.as_raw()[start..]);
            self.height += self.footer_height;
        }
        RgbaImage::from_raw(self.width, self.height, self.pixels)
            .ok_or_else(|| "invalid V2 capture canvas".into())
    }
}

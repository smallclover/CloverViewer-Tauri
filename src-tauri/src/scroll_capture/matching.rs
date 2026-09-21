//! Frame registration for the V2 scrolling capture engine.
//!
//! Registration deliberately ignores horizontal regions that are stationary at
//! the screen coordinate (sidebars, browser chrome).  White background is not
//! itself evidence of a sidebar: only a whole *textured segment* that remains
//! at the same rows is excluded from the displacement search.

use image::RgbaImage;

use super::{frame_metrics, frame_shift, grayscale, ShiftEstimate};

pub const MIN_SHIFT: u32 = 4;
const SEGMENTS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Registration {
    pub shift: u32,
    pub top_fixed: u32,
    pub bottom_fixed: u32,
    pub support: f32,
    pub mean_error: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RegistrationVerdict {
    Accepted(Registration),
    NoMotion,
    Reverse,
    /// Retained for the public diagnostic contract. V2 no longer emits this
    /// based on blank background pixels; it would reject normal web articles.
    StaticRegion {
        percent: u8,
    },
    Uncertain {
        reason: &'static str,
    },
}

#[derive(Debug, Default)]
pub struct FrameRegistrar {
    prior_shift: Option<u32>,
}

impl FrameRegistrar {
    pub fn register(&mut self, previous: &RgbaImage, current: &RgbaImage) -> RegistrationVerdict {
        let verdict = register_frames(previous, current, self.prior_shift);
        if let RegistrationVerdict::Accepted(registration) = verdict {
            self.prior_shift = Some(registration.shift);
        }
        verdict
    }
}

/// Coarse grayscale displacement estimate retained for the diagnostic probe.
pub fn estimate_shift(previous: &RgbaImage, current: &RgbaImage) -> Option<ShiftEstimate> {
    if previous.dimensions() != current.dimensions() {
        return None;
    }
    let (a, width, height) = grayscale::downsample(previous, 320);
    let (b, width_b, height_b) = grayscale::downsample(current, 320);
    (width == width_b && height == height_b)
        .then(|| frame_shift::from_grays(&a, &b, width as usize, height))
        .flatten()
}

fn register_frames(
    previous: &RgbaImage,
    current: &RgbaImage,
    prior: Option<u32>,
) -> RegistrationVerdict {
    let (width, height) = current.dimensions();
    if previous.dimensions() != current.dimensions() || width < 32 || height < 64 {
        return RegistrationVerdict::Uncertain {
            reason: "captured frame dimensions changed",
        };
    }
    if frame_metrics::diff_ratio(previous, current, 4) < 0.001 {
        return RegistrationVerdict::NoMotion;
    }
    if let Some(registration) = find_registration(previous, current, prior) {
        return RegistrationVerdict::Accepted(registration);
    }
    // A manual scroll may travel upwards. Test the reversed ordering only for
    // classification; it must never be appended at the tail.
    if find_registration(current, previous, prior).is_some() {
        RegistrationVerdict::Reverse
    } else {
        RegistrationVerdict::Uncertain {
            reason: "no consistent textured overlap was found",
        }
    }
}

struct FingerprintGrid {
    rows: Vec<Vec<u64>>,
    informative: Vec<Vec<bool>>,
    moving: Vec<bool>,
}

impl FingerprintGrid {
    fn pair(previous: &RgbaImage, current: &RgbaImage, x0: u32, x1: u32) -> (Self, Self) {
        let h = previous.height() as usize;
        let span = x1.saturating_sub(x0).max(1);
        let segment_width = (span / SEGMENTS).max(1);
        let mut old_rows = Vec::with_capacity(SEGMENTS as usize);
        let mut new_rows = Vec::with_capacity(SEGMENTS as usize);
        let mut old_informative = Vec::with_capacity(SEGMENTS as usize);
        let mut new_informative = Vec::with_capacity(SEGMENTS as usize);
        let mut moving = Vec::with_capacity(SEGMENTS as usize);
        for segment in 0..SEGMENTS {
            let start = (x0 + segment * segment_width).min(x1.saturating_sub(1));
            let end = if segment + 1 == SEGMENTS {
                x1
            } else {
                (start + segment_width).min(x1)
            }
            .max(start + 1);
            let (old, old_activity) = row_signatures(previous, start, end);
            let (new, new_activity) = row_signatures(current, start, end);
            let informative_rows: Vec<usize> = (0..h)
                .filter(|row| old_activity[*row] || new_activity[*row])
                .collect();
            let equal = informative_rows
                .iter()
                .filter(|row| old[**row] == new[**row])
                .count();
            // Uniform white rows are not evidence of a sidebar. Only rows
            // with horizontal detail may classify a segment as stationary.
            moving.push(
                informative_rows.len() < h / 20
                    || equal as f32 / (informative_rows.len().max(1) as f32) < 0.5,
            );
            old_rows.push(old);
            new_rows.push(new);
            old_informative.push(old_activity);
            new_informative.push(new_activity);
        }
        if !moving.iter().any(|value| *value) {
            moving.fill(true);
        }
        (
            Self {
                rows: old_rows,
                informative: old_informative,
                moving: moving.clone(),
            },
            Self {
                rows: new_rows,
                informative: new_informative,
                moving,
            },
        )
    }

    fn same_row(&self, other: &Self, y: usize) -> bool {
        self.row_match(other, y, y)
    }

    fn row_match(&self, other: &Self, current_y: usize, previous_y: usize) -> bool {
        self.rows.iter().enumerate().all(|(segment, rows)| {
            !self.moving[segment]
                || !self.informative[segment][current_y]
                || !other.informative[segment][previous_y]
                || rows[current_y] == other.rows[segment][previous_y]
        })
    }

    fn has_evidence(&self, other: &Self, current_y: usize, previous_y: usize) -> bool {
        self.informative.iter().enumerate().any(|(segment, rows)| {
            self.moving[segment] && rows[current_y] && other.informative[segment][previous_y]
        })
    }
}

fn row_signatures(image: &RgbaImage, x0: u32, x1: u32) -> (Vec<u64>, Vec<bool>) {
    let (width, height) = image.dimensions();
    let raw = image.as_raw();
    let mut output = Vec::with_capacity(height as usize);
    let mut informative = Vec::with_capacity(height as usize);
    for y in 0..height {
        let mut hash = 0xcbf2_9ce4_8422_2325u64;
        let mut activity = 0u64;
        let mut samples = 0u64;
        for x in (x0..x1.min(width)).step_by(4) {
            let i = ((y * width + x) * 4) as usize;
            let rgb = ((raw[i] >> 3) as u64) << 10
                | ((raw[i + 1] >> 3) as u64) << 5
                | (raw[i + 2] >> 3) as u64;
            hash = (hash ^ rgb).wrapping_mul(0x0000_0100_0000_01b3);
            if x >= x0 + 2 {
                let left = ((y * width + x - 2) * 4) as usize;
                activity += (raw[i] as i16 - raw[left] as i16).unsigned_abs() as u64;
                activity += (raw[i + 1] as i16 - raw[left + 1] as i16).unsigned_abs() as u64;
                activity += (raw[i + 2] as i16 - raw[left + 2] as i16).unsigned_abs() as u64;
                samples += 1;
            }
        }
        output.push(hash);
        informative.push(activity > samples.saturating_mul(18));
    }
    (output, informative)
}

fn find_registration(
    previous: &RgbaImage,
    current: &RgbaImage,
    prior: Option<u32>,
) -> Option<Registration> {
    let (width, height) = current.dimensions();
    let side = (width / 20).clamp(24, width / 3);
    let x0 = side;
    let x1 = width.saturating_sub(side);
    if x1 <= x0 + 16 {
        return None;
    }
    let (old, new) = FingerprintGrid::pair(previous, current, x0, x1);
    let edge_cap = (height / 4).min(120);
    let mut top_fixed = 0u32;
    while top_fixed < edge_cap && new.same_row(&old, top_fixed as usize) {
        top_fixed += 1;
    }
    let mut bottom_fixed = 0u32;
    while bottom_fixed < edge_cap
        && bottom_fixed < height.saturating_sub(1)
        && new.same_row(&old, (height - 1 - bottom_fixed) as usize)
    {
        bottom_fixed += 1;
    }
    let min_overlap = (height / 10).clamp(32, 240);
    let max_shift = height
        .saturating_sub(bottom_fixed)
        .saturating_sub(min_overlap);
    if max_shift < MIN_SHIFT {
        return None;
    }

    // Rank by matching *informative* rows. Without this, a white document can
    // make every small displacement look perfect because blank rows agree at
    // every offset.
    let mut candidates = Vec::new(); // shift, informative matches, longest evidence run
    let min_evidence = (min_overlap / 3).clamp(12, 64);
    for shift in MIN_SHIFT..=max_shift {
        let end = height.saturating_sub(bottom_fixed).saturating_sub(shift);
        let mut run = 0u32;
        let mut best_run = 0u32;
        let mut evidence_matches = 0u32;
        for y in top_fixed..end {
            let current_y = y as usize;
            let previous_y = (y + shift) as usize;
            if new.row_match(&old, current_y, previous_y) {
                if new.has_evidence(&old, current_y, previous_y) {
                    run += 1;
                    evidence_matches += 1;
                    best_run = best_run.max(run);
                }
            } else {
                run = 0;
            }
        }
        if evidence_matches >= min_evidence {
            candidates.push((shift, evidence_matches, best_run));
        }
    }
    let best_evidence = candidates.iter().map(|(_, evidence, _)| *evidence).max()?;
    let chosen = match prior {
        Some(previous_shift) => candidates
            .iter()
            .filter(|(_, evidence, _)| *evidence * 100 >= best_evidence * 90)
            .min_by_key(|(shift, evidence, run)| {
                (
                    shift.abs_diff(previous_shift),
                    std::cmp::Reverse(*evidence),
                    std::cmp::Reverse(*run),
                )
            })
            .map(|(shift, _, _)| *shift),
        None => candidates
            .iter()
            .max_by_key(|(shift, evidence, run)| (*evidence, *run, std::cmp::Reverse(*shift)))
            .map(|(shift, _, _)| *shift),
    }?;
    let (support, mean_error) =
        alignment_quality(previous, current, chosen, top_fixed, bottom_fixed, x0, x1);
    (support >= 0.55 && mean_error <= 38.0).then_some(Registration {
        shift: chosen,
        top_fixed,
        bottom_fixed,
        support,
        mean_error,
    })
}

fn alignment_quality(
    previous: &RgbaImage,
    current: &RgbaImage,
    shift: u32,
    top: u32,
    bottom: u32,
    x0: u32,
    x1: u32,
) -> (f32, f32) {
    let (width, height) = current.dimensions();
    let end = height.saturating_sub(bottom).saturating_sub(shift);
    if end <= top {
        return (0.0, f32::MAX);
    }
    let old = previous.as_raw();
    let new = current.as_raw();
    let mut inliers = 0u32;
    let mut total = 0u32;
    let mut error = 0u64;
    for y in (top..end).step_by(3) {
        for x in (x0..x1).step_by(4) {
            let a = (((y + shift) * width + x) * 4) as usize;
            let b = ((y * width + x) * 4) as usize;
            let delta = (old[a] as i16 - new[b] as i16).unsigned_abs()
                + (old[a + 1] as i16 - new[b + 1] as i16).unsigned_abs()
                + (old[a + 2] as i16 - new[b + 2] as i16).unsigned_abs();
            if delta <= 54 {
                inliers += 1;
            }
            error += delta as u64;
            total += 1;
        }
    }
    (
        inliers as f32 / total.max(1) as f32,
        error as f32 / total.max(1) as f32 / 3.0,
    )
}

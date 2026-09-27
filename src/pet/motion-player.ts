type MotionCurve = {
  id: string;
  points: Array<{ time: number; value: number }>;
};

type MotionFile = {
  Meta?: { Duration?: unknown; Loop?: unknown };
  Curves?: Array<{ Target?: unknown; Id?: unknown; Segments?: unknown }>;
};

type MotionClip = {
  duration: number;
  loop: boolean;
  curves: MotionCurve[];
};

/** Samples PSD2Live's parameter-only motion exports without a full motion manager. */
export class PetMotionPlayer {
  private readonly clips = new Map<string, MotionClip>();

  static async load(
    references: Record<string, Array<{ File?: unknown }>> | undefined,
    resolve: (path: string) => string,
  ): Promise<PetMotionPlayer> {
    const player = new PetMotionPlayer();
    await Promise.all(
      Object.entries(references ?? {}).map(async ([name, entries]) => {
        const file = entries[0]?.File;
        if (typeof file !== "string") return;
        try {
          const response = await fetch(resolve(file));
          if (!response.ok) return;
          const clip = parseMotion((await response.json()) as MotionFile);
          if (clip) player.clips.set(name, clip);
        } catch {
          // A missing optional animation must not prevent the pet from loading.
        }
      }),
    );
    return player;
  }

  has(name: string): boolean {
    return this.clips.has(name);
  }

  isFinished(name: string, elapsedSeconds: number): boolean {
    const clip = this.clips.get(name);
    return !clip || (!clip.loop && elapsedSeconds >= clip.duration);
  }

  sample(name: string, elapsedSeconds: number, apply: (id: string, value: number) => void): void {
    const clip = this.clips.get(name);
    if (!clip) return;
    const time = clip.loop
      ? elapsedSeconds % clip.duration
      : Math.min(elapsedSeconds, clip.duration);
    for (const curve of clip.curves) apply(curve.id, sampleCurve(curve, time));
  }
}

function parseMotion(file: MotionFile): MotionClip | undefined {
  const duration = Number(file.Meta?.Duration);
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  const curves = (file.Curves ?? []).flatMap((curve) => {
    if (curve.Target !== "Parameter" || typeof curve.Id !== "string") return [];
    const points = parseLinearSegments(curve.Segments);
    return points ? [{ id: curve.Id, points }] : [];
  });
  return { duration, loop: file.Meta?.Loop === true, curves };
}

/** PSD2Live's restricted exports use linear (type 0) segments. */
function parseLinearSegments(segments: unknown): MotionCurve["points"] | undefined {
  if (!Array.isArray(segments) || segments.length < 2) return undefined;
  const firstTime = Number(segments[0]);
  const firstValue = Number(segments[1]);
  if (!Number.isFinite(firstTime) || !Number.isFinite(firstValue)) return undefined;
  const points = [{ time: firstTime, value: firstValue }];
  for (let index = 2; index < segments.length; ) {
    if (segments[index++] !== 0) return undefined;
    const time = Number(segments[index++]);
    const value = Number(segments[index++]);
    if (!Number.isFinite(time) || !Number.isFinite(value)) return undefined;
    points.push({ time, value });
  }
  return points;
}

function sampleCurve(curve: MotionCurve, time: number): number {
  const points = curve.points;
  for (let index = 1; index < points.length; index++) {
    const next = points[index];
    if (time > next.time) continue;
    const previous = points[index - 1];
    const span = next.time - previous.time;
    const progress = span > 0 ? (time - previous.time) / span : 1;
    return previous.value + (next.value - previous.value) * progress;
  }
  return points[points.length - 1]?.value ?? 0;
}

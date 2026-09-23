interface DatedImage {
  modified: string;
  path: string;
}

const timestampOf = (image: DatedImage) => {
  const timestamp = new Date(image.modified).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

/** Returns a deterministic modification-time ordering without mutating the input. */
export function sortImagesByModified<T extends DatedImage>(
  images: readonly T[],
  newestFirst: boolean,
): T[] {
  return [...images].sort((a, b) => {
    const delta = timestampOf(a) - timestampOf(b);
    if (delta !== 0) return newestFirst ? -delta : delta;
    return a.path.localeCompare(b.path);
  });
}

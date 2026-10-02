interface DatedImage {
  modified: string;
  path: string;
}

const timestampOf = (image: DatedImage) => {
  const timestamp = new Date(image.modified).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

/** 按修改时间排序且不改动入参数组；时间无效或相同则按路径比较，结果稳定可预期。 */
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

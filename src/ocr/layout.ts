import type { OcrDocument, OcrLine, OcrPoint } from "../api";

export interface OcrBounds {
  x: number;
  y: number;
  right: number;
  bottom: number;
}
export interface OcrBlock {
  id: string;
  lines: OcrLine[];
  original: string;
}

export function boundsOf(points: readonly OcrPoint[]): OcrBounds {
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const p of points) {
    x = Math.min(x, p.x);
    y = Math.min(y, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x, y, right, bottom };
}

/** Split only at an actual empty vertical gutter; uncertain layouts keep engine row order. */
export function readingOrder(lines: readonly OcrLine[]): OcrLine[] {
  if (lines.length < 2) return [...lines];
  const horizontal = [...lines].sort((a, b) => boundsOf(a.quad).x - boundsOf(b.quad).x);
  let right = boundsOf(horizontal[0].quad).right;
  const columns: OcrLine[][] = [[horizontal[0]]];
  for (let i = 1; i < horizontal.length; i++) {
    const b = boundsOf(horizontal[i].quad);
    if (b.x - right > Math.max(20, (b.bottom - b.y) * 2)) columns.push([]);
    columns[columns.length - 1].push(horizontal[i]);
    right = Math.max(right, b.right);
  }
  if (columns.length > 1 && columns.every((column) => column.length >= 2))
    return columns.flatMap((column) =>
      column.sort((a, b) => boundsOf(a.quad).y - boundsOf(b.quad).y),
    );
  return [...lines].sort((a, b) => {
    const aa = boundsOf(a.quad),
      bb = boundsOf(b.quad);
    return aa.y - bb.y || aa.x - bb.x;
  });
}

const direction = (line: OcrLine) =>
  Math.atan2(line.quad[1].y - line.quad[0].y, line.quad[1].x - line.quad[0].x);

export function groupLines(document: OcrDocument): OcrBlock[] {
  const blocks: OcrBlock[] = [];
  for (const line of readingOrder(document.lines)) {
    const previous = blocks[blocks.length - 1];
    const last = previous?.lines[previous.lines.length - 1];
    let merge = false;
    if (last) {
      const a = boundsOf(last.quad),
        b = boundsOf(line.quad);
      const ah = a.bottom - a.y,
        bh = b.bottom - b.y;
      const height = Math.max(1, Math.min(ah, bh));
      const overlap = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const aligned = Math.min(Math.abs(a.x - b.x), Math.abs(a.right - b.right)) < height * 1.2;
      merge =
        b.y >= a.bottom - height * 0.15 &&
        b.y - a.bottom < height * 1.15 &&
        overlap > height &&
        aligned &&
        Math.max(ah, bh) / height < 1.6 &&
        Math.abs(direction(last) - direction(line)) < 0.15;
    }
    if (merge && previous) {
      previous.lines.push(line);
      previous.original += `\n${line.text}`;
    } else blocks.push({ id: line.id, lines: [line], original: line.text });
  }
  return blocks;
}

/** Preserve list/code/path line boundaries; join prose without inserting CJK spaces. */
export function paragraphText(lines: readonly string[]): string {
  if (lines.some((line) => /^\s*(?:[-*•]|\d+[.)、]|[{}]|(?:[\w.-]+[/\\])+)/u.test(line)))
    return lines.join("\n");
  let result = "";
  for (const text of lines) {
    const line = text.trim();
    if (!result) {
      result = line;
      continue;
    }
    const previous = result[result.length - 1] ?? "";
    const first = line[0] ?? "";
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、；：]/u;
    result += (cjk.test(previous) || cjk.test(first) ? "" : " ") + line;
  }
  return result;
}

import type { OcrDocument, OcrLine } from "../api";
import { groupLines, paragraphText, type OcrBlock } from "./layout";

export type OcrCopyFormat = "paragraphs" | "lines";
export interface OcrSession {
  document?: OcrDocument;
  blocks: OcrBlock[];
  selected: Set<string>;
  edits: Map<string, string>;
}
export interface OcrUnit {
  id: string;
  block: OcrBlock;
  lines: OcrLine[];
}
export const keysFor = (block: OcrBlock, lines = block.lines): string[] =>
  lines.length ? lines.map((line) => line.id) : [block.id];

export function createOcrSession(result: OcrDocument | string): OcrSession {
  return {
    document: typeof result === "string" ? undefined : result,
    blocks:
      typeof result === "string" || !result.lines.length
        ? [{ id: "legacy", lines: [], original: typeof result === "string" ? result : result.text }]
        : groupLines(result),
    selected: new Set(),
    edits: new Map(),
  };
}

export function unitsFor(session: OcrSession, byLine: boolean): OcrUnit[] {
  return session.blocks.flatMap((block) =>
    byLine && !session.edits.has(block.id) && block.lines.length
      ? block.lines.map((line) => ({ id: line.id, block, lines: [line] }))
      : [{ id: block.id, block, lines: block.lines }],
  );
}

export function selectedState(session: OcrSession, unit: OcrUnit): "none" | "some" | "all" {
  const keys = keysFor(unit.block, unit.lines);
  const count = keys.filter((key) => session.selected.has(key)).length;
  return count === 0 ? "none" : count === keys.length ? "all" : "some";
}

export function toggleUnit(session: OcrSession, unit: OcrUnit, additive = true) {
  const state = selectedState(session, unit);
  if (!additive) session.selected.clear();
  for (const key of keysFor(unit.block, unit.lines)) {
    if (additive && state === "all") session.selected.delete(key);
    else session.selected.add(key);
  }
}

export function editBlock(session: OcrSession, block: OcrBlock, text: string | null) {
  if (text === null || text === block.original) session.edits.delete(block.id);
  else session.edits.set(block.id, text);
  // Any selected original line becomes the edited atomic block, never stale text.
  if (keysFor(block).some((key) => session.selected.has(key)))
    for (const key of keysFor(block)) session.selected.add(key);
}

export function copyContent(session: OcrSession, format: OcrCopyFormat, all = false): string {
  const blocks: string[] = [];
  for (const block of session.blocks) {
    const chosen = block.lines.filter((line) => all || session.selected.has(line.id));
    if (!all && !keysFor(block).some((key) => session.selected.has(key))) continue;
    const edited = session.edits.get(block.id);
    if (edited !== undefined) blocks.push(edited);
    else if (!block.lines.length) blocks.push(block.original);
    else
      blocks.push(
        format === "lines"
          ? chosen.map((line) => line.text).join("\n")
          : paragraphText(chosen.map((line) => line.text)),
      );
  }
  return blocks.join(format === "lines" ? "\n" : "\n\n");
}

import * as os from "node:os";
import * as path from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

const READ_HISTORY_LIMIT = 64;
const NEW_LINE_RATIO = 0.5;

/** One-based source lines in [start, end). */
interface ReadRange {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export function normalizeReadPath(file: unknown, cwd: string): string | undefined {
  if (typeof file !== "string") return undefined;
  const expanded = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
  return path.resolve(cwd, expanded);
}

/** Track returned text ranges, without reading files or retaining their contents. */
export class ReadProgress {
  private ranges: ReadRange[] = [];

  reset(): void {
    this.ranges = [];
  }

  record(event: Extract<ToolResultEvent, { toolName: "read" }>, cwd: string): boolean {
    const target = normalizeReadPath(event.input.path, cwd);
    if (event.isError || target === undefined) return false;
    if (event.content.length !== 1 || event.content[0]?.type !== "text") return false;
    const start = event.input.offset ?? 1;
    if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1) return false;
    const text = event.content[0].text;
    // Non-vision image reads contain only a text notice, not source lines.
    if (text.startsWith("Read image file [")) return false;
    const truncation = event.details?.truncation;
    let lineCount: number;
    if (truncation) {
      if (truncation.firstLineExceedsLimit || truncation.lastLinePartial) return false;
      lineCount = truncation.outputLines;
    } else {
      lineCount = text.length === 0 ? 0 : text.split("\n").length;
      const trailer = /\n\n\[\d+ more lines in file\. Use offset=(\d+) to continue\.\]$/.exec(text);
      const limit = event.input.limit;
      if (trailer && typeof limit === "number" && Number(trailer[1]) === start + limit) {
        const body = text.slice(0, trailer.index);
        // A validated footer can confirm one empty source line.
        if (body.split("\n").length === limit) lineCount = limit;
      }
    }
    if (
      !Number.isSafeInteger(lineCount) ||
      lineCount <= 0 ||
      !Number.isSafeInteger(start + lineCount)
    ) {
      return false;
    }

    const range: ReadRange = { path: target, start, end: start + lineCount };
    const overlaps = this.ranges
      .filter(
        (previous) =>
          previous.path === range.path && previous.end > start && previous.start < range.end,
      )
      .sort((a, b) => a.start - b.start);
    let covered = 0;
    let cursor = start;
    for (const previous of overlaps) {
      const overlapStart = Math.max(cursor, previous.start);
      const overlapEnd = Math.min(range.end, previous.end);
      if (overlapEnd > overlapStart) covered += overlapEnd - overlapStart;
      cursor = Math.max(cursor, overlapEnd);
    }
    this.ranges.push(range);
    if (this.ranges.length > READ_HISTORY_LIMIT) this.ranges.shift();
    return (lineCount - covered) / lineCount >= NEW_LINE_RATIO;
  }
}

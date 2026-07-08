import { truncateToWidth } from "@earendil-works/pi-tui";
import type { OversizedAssistantMessageSettings } from "../../core/mixcode-settings.js";
import { activeRenderTheme } from "./context.js";
import { renderBackgroundLine, sanitizeTerminalText } from "./primitives.js";

interface OversizedAssistantMessageInfo {
  bytes: number;
  lineCount: number;
  maxBytes: number;
  maxLines: number;
  head: string[];
  tail: string[];
}

export function isOversizedAssistantMessageText(
  text: string,
  policy: OversizedAssistantMessageSettings | undefined,
): boolean {
  if (!policy?.enabled) return false;
  if (Buffer.byteLength(text, "utf8") > policy.maxBytes) return true;
  let lineCount = 1;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    lineCount++;
    if (lineCount > policy.maxLines) return true;
  }
  return false;
}

export function renderOversizedAssistantMessageBlock(
  role: "assistant" | "thinking",
  text: string,
  policy: OversizedAssistantMessageSettings | undefined,
  width: number,
): string[] | undefined {
  const info = oversizedAssistantMessageInfo(text, policy);
  if (!info) return undefined;
  const rows = [
    "",
    ` ${activeRenderTheme.warning(activeRenderTheme.bold("[Oversized provider output]"))}`,
    ` role: ${role}`,
    ` size: ${formatBytes(info.bytes)} / ${info.lineCount.toLocaleString()} lines`,
    ` threshold: ${formatBytes(info.maxBytes)} OR ${info.maxLines.toLocaleString()} lines`,
    " full content is kept in the session; use /view to inspect it.",
    "",
    " raw preview:",
    ...renderRawPreviewLines(info, width),
    "",
    ` ${activeRenderTheme.warning("[Oversized provider output folded]")} full content kept; use /view`,
    "",
  ];
  return rows.map((part) => renderBackgroundLine(part, width, activeRenderTheme.systemBackground));
}

function oversizedAssistantMessageInfo(
  text: string,
  policy: OversizedAssistantMessageSettings | undefined,
): OversizedAssistantMessageInfo | undefined {
  if (!policy?.enabled) return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text.split(/\r?\n/);
  if (bytes <= policy.maxBytes && lines.length <= policy.maxLines) return undefined;
  const head = lines.slice(0, 20);
  const tailStart = lines.length > head.length ? Math.max(head.length, lines.length - 80) : lines.length;
  return {
    bytes,
    lineCount: lines.length,
    maxBytes: policy.maxBytes,
    maxLines: policy.maxLines,
    head,
    tail: lines.slice(tailStart),
  };
}

function renderRawPreviewLines(info: OversizedAssistantMessageInfo, width: number): string[] {
  const rows = info.head.map((line, index) => rawPreviewLine(index + 1, line, width));
  if (info.tail.length > 0) {
    const omitted = Math.max(0, info.lineCount - info.head.length - info.tail.length);
    if (omitted > 0) rows.push(` ... ${omitted.toLocaleString()} lines omitted ...`);
    const start = info.lineCount - info.tail.length + 1;
    rows.push(...info.tail.map((line, index) => rawPreviewLine(start + index, line, width)));
  }
  return rows;
}

function rawPreviewLine(lineNumber: number, line: string, width: number): string {
  const prefix = `${String(lineNumber).padStart(6, " ")} | `;
  const bodyWidth = Math.max(1, width - prefix.length - 1);
  const body = truncateToWidth(sanitizeTerminalText(line).replace(/\t/g, "  "), bodyWidth, "...");
  return ` ${activeRenderTheme.dim(prefix)}${body}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

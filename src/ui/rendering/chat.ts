import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ChatLine } from "../../agent/runtime.js";
import type { MixCodeTabInfo } from "../../core/types.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { renderMarkdown } from "./markdown.js";
import { padLine, sanitizeTerminalText } from "./primitives.js";

/**
 * Parsed skill block from a user message.
 * Matches the format produced by expandSkillCommand:
 * `<skill name="..." location="...">\n...\n</skill>[\n\nuserMessage]`
 */
interface ParsedSkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage: string | undefined;
}

const SKILL_BLOCK_RE =
  /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const match = text.match(SKILL_BLOCK_RE);
  if (!match) return null;
  return {
    name: match[1]!,
    location: match[2]!,
    content: match[3]!,
    userMessage: match[4]?.trim() || undefined,
  };
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const USER_BASH_PREVIEW_LINES = 20;
// Max chars to render for an explicitly active streaming assistant/thinking block.
// Complete messages render in full. At ~120 chars/line, 8000 chars produces
// ~67 lines, which is enough for any viewport + overscan.
export const STREAMING_MARKDOWN_CHAR_LIMIT = 8000;

export interface RenderChatBlockOptions { streamingMarkdownCharLimit?: number }

const chatLineRenderCache = new WeakMap<ChatLine, { key: string; lines: string[] }>();

export function renderChat(
  chat: ChatLine[],
  width: number,
  theme = activeRenderTheme,
  tab?: MixCodeTabInfo,
): string[] {
  return renderWithTheme(theme, () => renderChatStream(chat, width, tab));
}

export function renderConversation(
  chat: ChatLine[],
  width: number,
  tab?: MixCodeTabInfo,
): string[] {
  if (!chat.length) {
    return [
      padLine(activeRenderTheme.dim("No messages yet. Type a prompt and press Enter."), width),
      padLine("", width),
    ];
  }
  return renderChatStream(chat, width, tab);
}

/**
 * Render a single chat block with caching. Exposed for windowed rendering
 * paths that drive block rendering on demand instead of all-at-once.
 */
export function renderChatBlock(
  line: ChatLine,
  width: number,
  tab?: MixCodeTabInfo,
  theme = activeRenderTheme,
  options: RenderChatBlockOptions = {},
): string[] {
  return renderWithTheme(theme, () => renderMessageBlock(line, width, tab, options));
}

/**
 * Return the cached rendered height for a chat block under the current
 * (theme, width, tab) context, or undefined if it hasn't been rendered yet.
 * Used by the windowed renderer to estimate total scroll height without
 * forcing every block to render.
 */
export function cachedChatBlockHeight(
  line: ChatLine,
  width: number,
  tab?: MixCodeTabInfo,
  theme = activeRenderTheme,
): number | undefined {
  const expectedKey = renderWithTheme(theme, () => chatLineRenderCacheKey(line, width, tab));
  if (!expectedKey) return undefined;
  const cached = chatLineRenderCache.get(line);
  if (cached?.key === expectedKey) return cached.lines.length;
  return undefined;
}

/**
 * Render the empty-state placeholder shown when the chat is empty. Pulled out
 * so windowed renderers can short-circuit with the same output as
 * renderConversation for that edge case.
 */
export function renderConversationEmptyState(width: number): string[] {
  return [
    padLine(activeRenderTheme.dim("No messages yet. Type a prompt and press Enter."), width),
    padLine("", width),
  ];
}

/** Standard blank separator row used between non-empty chat blocks. */
export function chatBlockSeparator(width: number): string {
  return padLine("", width);
}

// Per-line render cache strategy:
// Each ChatLine is rendered in isolation and the result is cached on the line
// object itself (via the WeakMap below in renderMessageBlock). On re-render we
// walk the chat array and reuse cached blocks for any line whose reference and
// content key are unchanged. This makes the common case (one line at the end
// mutated, or N lines appended) cost roughly "only the changed lines" instead
// of "the entire chat". Lines that depend on dynamic side-effecting renderers
// (extensions, tool renderers) opt out via chatLineRenderCacheKey returning
// undefined and are re-rendered each frame.

function renderChatStream(chat: ChatLine[], width: number, tab?: MixCodeTabInfo): string[] {
  if (!chat.length) return [padLine(activeRenderTheme.dim("No messages yet."), width)];
  if (chat.length === 1) {
    return renderMessageBlock(chat[0]!, width, tab);
  }

  // Render each block (per-line cache hits keep this cheap for unchanged lines).
  const blocks = new Array<string[]>(chat.length);
  let totalLength = 0;
  let nonEmptyCount = 0;
  for (let i = 0; i < chat.length; i++) {
    const block = renderMessageBlock(chat[i]!, width, tab);
    blocks[i] = block;
    totalLength += block.length;
    if (block.length > 0) nonEmptyCount++;
  }

  // One blank-line separator between every pair of non-empty blocks.
  const separator = padLine("", width);
  const result = new Array<string>(totalLength + Math.max(0, nonEmptyCount - 1));
  let cursor = 0;
  let seenNonEmpty = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.length === 0) continue;
    if (seenNonEmpty) result[cursor++] = separator;
    seenNonEmpty = true;
    for (let j = 0; j < block.length; j++) result[cursor++] = block[j]!;
  }
  return result;
}

function renderMessageBlock(
  line: ChatLine,
  width: number,
  tab?: MixCodeTabInfo,
  options: RenderChatBlockOptions = {},
): string[] {
  const cacheKey = chatLineRenderCacheKey(line, width, tab);
  const truncatesStreamingText = shouldTruncateStreamingMarkdown(line, options);
  if (cacheKey && !truncatesStreamingText) {
    const cached = chatLineRenderCache.get(line);
    if (cached?.key === cacheKey) return cached.lines;
    const rendered = renderMessageBlockUncached(line, width, tab, options);
    chatLineRenderCache.set(line, { key: cacheKey, lines: rendered });
    return rendered;
  }
  return renderMessageBlockUncached(line, width, tab, options);
}

function renderMessageBlockUncached(
  line: ChatLine,
  width: number,
  tab?: MixCodeTabInfo,
  options: RenderChatBlockOptions = {},
): string[] {
  const text = line.text.trimEnd();
  if (line.role === "user") {
    if (!text.trim()) return [];
    // Detect skill block and render collapsed/expanded
    const skillBlock = parseSkillBlock(text);
    if (skillBlock) {
      return renderSkillUserMessage(skillBlock, width, tab);
    }
    const innerWidth = Math.max(1, width - 2);
    const body = wrapPlainLine(text, innerWidth).map((part) =>
      activeRenderTheme.userMessage(padLine(` ${part}`, width)),
    );
    return [
      OSC133_ZONE_START + activeRenderTheme.userMessage(padLine("", width)),
      ...body,
      activeRenderTheme.userMessage(padLine("", width)) + OSC133_ZONE_END + OSC133_ZONE_FINAL,
    ];
  }
  if (line.role === "assistant") {
    if (!text.trim()) return [];
    const trimmed = text.trim();
    return withOsc133Zone(renderMarkdown(streamingMarkdownText(trimmed, options), width));
  }
  if (line.role === "thinking") {
    if (!text.trim()) return [];
    const trimmed = text.trim();
    return renderMarkdown(streamingMarkdownText(trimmed, options), width, {
      color: activeRenderTheme.thinking,
      italic: true,
    });
  }
  if (line.role === "tool") {
    return renderToolBlock(line, width, tab);
  }
  if (line.role === "extension") {
    return renderExtensionBlock(line, width);
  }
  if (line.role === "startup") {
    return renderStartupBlock(text, width);
  }
  if (line.branchSummary) {
    return renderBranchSummaryBlock(text, width, tab);
  }
  if (line.compactionSummary) {
    return renderCompactionSummaryBlock(text, width, line.compactionTokensBefore, tab);
  }
  return renderSystemBlock(text, width, line.variant);
}

function shouldTruncateStreamingMarkdown(line: ChatLine, options: RenderChatBlockOptions): boolean {
  const limit = options.streamingMarkdownCharLimit;
  return (
    limit !== undefined &&
    (line.role === "assistant" || line.role === "thinking") &&
    line.text.trim().length > limit
  );
}

function streamingMarkdownText(text: string, options: RenderChatBlockOptions): string {
  const limit = options.streamingMarkdownCharLimit;
  if (limit === undefined || limit <= 0 || text.length <= limit) return text;
  // Only active streaming blocks use this path; complete messages render fully.
  return text.slice(-limit);
}

function withOsc133Zone(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const result = lines.slice();
  result[0] = OSC133_ZONE_START + result[0]!;
  result[result.length - 1] = `${result[result.length - 1]!}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}`;
  return result;
}

// Field separator used when concatenating cache key components. Picked
// because content fields render as ANSI/printable text and never contain
// raw \u0001 bytes (those are stripped by sanitizeTerminalText upstream).
// Using string concat instead of JSON.stringify is ~5-10x faster on the
// hot per-line cache key path.
const KEY_SEP = "\u0001";

/**
 * Build a cache key for a chat line. Returning undefined opts out of caching
 * (used for lines that depend on dynamic side-effecting renderers, where the
 * renderer call must run on every frame so component lifecycle hooks fire).
 *
 * The key includes every input that affects the rendered output for the
 * specific render branch the line falls into. Roles are partitioned by branch
 * so we don't accidentally hash unrelated fields.
 */
function chatLineRenderCacheKey(
  line: ChatLine,
  width: number,
  tab?: MixCodeTabInfo,
): string | undefined {
  // Dynamic renderers must execute every frame for lifecycle correctness.
  if (line.renderExtension || line.renderToolCall || line.renderToolResult) return undefined;
  const themeName = activeRenderTheme.name;
  const role = line.role;

  // Hot paths first (assistant/thinking dominate any long chat).
  if (role === "assistant" || role === "thinking") {
    return `${role[0]}${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${line.text}`;
  }
  const expanded = tab?.extensionUi.toolsExpanded ?? false;
  if (role === "user") {
    // Skill blocks switch on toolsExpanded; safe to include unconditionally.
    return `u${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${expanded ? 1 : 0}${KEY_SEP}${line.text}`;
  }
  if (role === "startup") {
    return `st${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${line.text}`;
  }
  if (role === "extension") {
    return `e${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${line.title ?? ""}${KEY_SEP}${line.customType ?? ""}${KEY_SEP}${line.text}`;
  }
  if (role === "tool") {
    if (line.variant === "user-bash") {
      // user-bash branch reads almost every bash-related field plus the
      // global toolsExpanded toggle and per-line toolExpanded fallback.
      return `ub${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${line.status ?? ""}${KEY_SEP}${line.title ?? ""}${KEY_SEP}${commandFromArgs(line.args)}${KEY_SEP}${line.excludeFromContext === true ? 1 : 0}${KEY_SEP}${line.bashExitCode ?? ""}${KEY_SEP}${line.bashCancelled === true ? 1 : 0}${KEY_SEP}${line.bashTruncated === true ? 1 : 0}${KEY_SEP}${line.bashFullOutputPath ?? ""}${KEY_SEP}${line.toolExpanded === true ? 1 : 0}${KEY_SEP}${expanded ? 1 : 0}${KEY_SEP}${line.text}`;
    }
    // Generic (non-renderer) tool block: depends on status/title/args/text.
    return `t${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${line.status ?? ""}${KEY_SEP}${line.title ?? ""}${KEY_SEP}${stableArgs(line.args)}${KEY_SEP}${line.text}`;
  }
  // role === "system" path can also surface branch-summary and compaction-summary blocks.
  if (line.branchSummary) {
    return `bs${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${expanded ? 1 : 0}${KEY_SEP}${line.text}`;
  }
  if (line.compactionSummary) {
    return `cs${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${expanded ? 1 : 0}${KEY_SEP}${line.compactionTokensBefore ?? 0}${KEY_SEP}${line.text}`;
  }
  return `s${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${line.variant ?? ""}${KEY_SEP}${line.text}`;
}

function commandFromArgs(args: unknown): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const command = (args as { command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return "";
}

// Args may include unhashable values (functions, cycles) but in practice the
// agent runtime only writes JSON-safe args. JSON.stringify with a try/catch
// guards the rare bad-input case so caching just disables silently.
function stableArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

function renderToolBlock(line: ChatLine, width: number, tab?: MixCodeTabInfo): string[] {
  if (line.variant === "user-bash") return renderUserBashBlock(line, width, tab);
  if (line.renderToolCall || line.renderToolResult) {
    const selfRendered = line.toolRenderShell === "self";
    const renderedWidth = selfRendered ? width : Math.max(1, width - 2);
    const renderedResult = line.renderToolResult?.(renderedWidth) ?? [];
    const rendered = [...(line.renderToolCall?.(renderedWidth) ?? []), ...renderedResult];
    if (rendered.length) {
      if (selfRendered) return rendered.flatMap((part) => normalizeRenderedToolLine(part, width));
      return ["", ...rendered, ""].flatMap((part) => renderToolRenderedLine(line, part, width));
    }
  }
  const status = line.status ?? "success";
  const background =
    status === "error"
      ? activeRenderTheme.toolErrorBackground
      : status === "success"
        ? activeRenderTheme.toolSuccessBackground
        : activeRenderTheme.toolPendingBackground;
  const innerWidth = Math.max(1, width - 2);
  const titleColor =
    status === "error"
      ? activeRenderTheme.danger
      : status === "success"
        ? activeRenderTheme.success
        : activeRenderTheme.tool;
  const title = titleColor(activeRenderTheme.bold(toolDisplayTitle(line)));
  const body = toolBodyLines(line);
  const lines = [
    "",
    ` ${title}`,
    ...body.flatMap((item) =>
      wrapTextWithAnsi(item || " ", innerWidth).map((part) => ` ${activeRenderTheme.dim(part)}`),
    ),
    "",
  ];
  return lines.map((part) => renderToolBackgroundLine(part, width, background));
}

function renderUserBashBlock(line: ChatLine, width: number, tab?: MixCodeTabInfo): string[] {
  const innerWidth = Math.max(1, width - 1);
  const color = line.excludeFromContext ? activeRenderTheme.dim : activeRenderTheme.shellBorder;
  const title = color(activeRenderTheme.bold(toolDisplayTitle(line)));
  const output = line.text.trimEnd();
  const outputLines = output ? output.split(/\r?\n/) : [];
  const expanded = tab?.extensionUi.toolsExpanded ?? line.toolExpanded === true;
  const visibleOutput = outputLines.slice(
    expanded ? 0 : Math.max(0, outputLines.length - USER_BASH_PREVIEW_LINES),
  );
  const hiddenLineCount = Math.max(0, outputLines.length - visibleOutput.length);
  const body: string[] = [userBashRule(width, color), ` ${title}`];
  if (visibleOutput.length) {
    body.push(
      "",
      ...visibleOutput.flatMap((item) =>
        wrapTextWithAnsi(item || " ", innerWidth).map((part) => ` ${activeRenderTheme.dim(part)}`),
      ),
    );
  }
  const statusLines = userBashStatusLines(line, hiddenLineCount, expanded);
  if (statusLines.length) body.push("", ...statusLines.map((part) => ` ${part}`));
  body.push(userBashRule(width, color));
  return body.map((part) => padLine(part, width));
}

function userBashRule(width: number, color = activeRenderTheme.tool): string {
  return color("─".repeat(Math.max(1, width)));
}

function userBashStatusLines(line: ChatLine, hiddenLineCount: number, expanded: boolean): string[] {
  const lines: string[] = [];
  if (hiddenLineCount > 0) {
    const label = expanded
      ? "(ctrl+o to collapse)"
      : `... ${hiddenLineCount} more lines (ctrl+o to expand)`;
    lines.push(activeRenderTheme.dim(label));
  }
  if (line.status === "running") lines.push(activeRenderTheme.dim("Running..."));
  if (line.status !== "running" && line.bashCancelled === true) {
    lines.push(activeRenderTheme.warning("(cancelled)"));
  } else if (
    line.status !== "running" &&
    line.bashExitCode !== undefined &&
    line.bashExitCode !== 0
  ) {
    lines.push(activeRenderTheme.danger(`(exit ${line.bashExitCode})`));
  }
  if (line.status !== "running" && line.bashTruncated === true && line.bashFullOutputPath) {
    lines.push(
      activeRenderTheme.warning(`Output truncated. Full output: ${line.bashFullOutputPath}`),
    );
  }
  return lines;
}

function renderExtensionBlock(line: ChatLine, width: number): string[] {
  if (line.renderExtension) {
    const rendered = line.renderExtension(width);
    if (rendered.length)
      return rendered.flatMap((part) => normalizeRenderedExtensionLine(part, width));
  }
  const title = line.title || (line.customType ? `extension ${line.customType}` : "extension");
  const header = activeRenderTheme.accent(activeRenderTheme.bold(title));
  const body = line.text.trim() ? line.text.trim() : " ";
  return [
    padLine(` ${header}`, width),
    ...body
      .split(/\r?\n/)
      .flatMap((rawLine) =>
        wrapTextWithAnsi(rawLine || " ", Math.max(1, width - 2)).map((part) =>
          padLine(` ${activeRenderTheme.dim(part)}`, width),
        ),
      ),
  ];
}

function renderSystemBlock(text: string, width: number, variant?: string): string[] {
  const body = text.trim() ? text.trim() : " ";
  const isError = variant === "system-error" || text.startsWith("Error:");
  if (isError) {
    // Error system messages render entirely in the danger color (title + body),
    // mirroring Pi's plain red error text instead of a markdown-rendered body.
    const title = activeRenderTheme.danger(activeRenderTheme.bold("[System]:"));
    const bodyLines = wrapPlainLine(body, Math.max(1, width - 1)).map(
      (part) => ` ${activeRenderTheme.danger(part)}`,
    );
    const lines = ["", ` ${title}`, ...bodyLines, ""];
    return lines.map((part) =>
      renderToolBackgroundLine(part, width, activeRenderTheme.systemBackground),
    );
  }
  const title = activeRenderTheme.accent(activeRenderTheme.bold("[System]:"));
  const lines = [
    "",
    ` ${title}`,
    ...renderMarkdown(body, Math.max(1, width - 1)).map((line) => ` ${line}`),
    "",
  ];
  return lines.map((part) => renderToolBackgroundLine(part, width, activeRenderTheme.systemBackground));
}

function renderBranchSummaryBlock(
  text: string,
  width: number,
  tab?: MixCodeTabInfo,
): string[] {
  const expanded = tab?.extensionUi.toolsExpanded ?? false;
  const title = activeRenderTheme.accent(activeRenderTheme.bold("[branch]"));
  const lines: string[] = ["", ` ${title}`];
  if (expanded) {
    lines.push(
      "",
      ...renderMarkdown(text.trim(), Math.max(1, width - 1)).map((line) => ` ${line}`),
    );
  } else {
    lines.push(
      ` ${activeRenderTheme.dim("Branch summary (ctrl+o to expand)")}`
    );
  }
  lines.push("");
  return lines.map((part) => renderToolBackgroundLine(part, width, activeRenderTheme.systemBackground));
}

function renderCompactionSummaryBlock(
  text: string,
  width: number,
  tokensBefore: number | undefined,
  tab?: MixCodeTabInfo,
): string[] {
  const expanded = tab?.extensionUi.toolsExpanded ?? false;
  const title = activeRenderTheme.accent(activeRenderTheme.bold("[compaction]"));
  const lines: string[] = ["", ` ${title}`];
  if (expanded) {
    const header = tokensBefore
      ? `**Compacted from ${tokensBefore.toLocaleString()} tokens**\n\n`
      : "";
    lines.push(
      "",
      ...renderMarkdown((header + text).trim(), Math.max(1, width - 1)).map((line) => ` ${line}`),
    );
  } else {
    const tokenInfo = tokensBefore
      ? `Compacted from ${tokensBefore.toLocaleString()} tokens`
      : "Compacted";
    lines.push(
      ` ${activeRenderTheme.dim(`${tokenInfo} (ctrl+o to expand)`)}`
    );
  }
  lines.push("");
  return lines.map((part) => renderToolBackgroundLine(part, width, activeRenderTheme.systemBackground));
}

function renderStartupBlock(text: string, width: number): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (/^\[[^\]]+\]$/.test(line.trim())) {
      return [padLine(activeRenderTheme.tool(line.trim()), width)];
    }
    // Wrap long resource lists (e.g. comma-separated skills/extensions) so the
    // full content stays visible instead of being clipped with an ellipsis.
    // Continuation lines keep the original leading indent (hanging indent).
    const indent = line.match(/^\s*/)?.[0] ?? "";
    const content = line.slice(indent.length);
    const wrapWidth = Math.max(1, width - indent.length);
    return wrapTextWithAnsi(content, wrapWidth).map((part) =>
      padLine(activeRenderTheme.dim(`${indent}${part}`), width),
    );
  });
}

function normalizeRenderedExtensionLine(line: string, width: number): string[] {
  return normalizeExternalRendererLines(line, width).map((part) => padLine(part, width));
}

function renderToolRenderedLine(line: ChatLine, text: string, width: number): string[] {
  const status = line.status ?? "success";
  const background =
    status === "error"
      ? activeRenderTheme.toolErrorBackground
      : status === "success"
        ? activeRenderTheme.toolSuccessBackground
        : activeRenderTheme.toolPendingBackground;
  const innerWidth = Math.max(1, width - 1);
  return normalizeExternalRendererLines(text, innerWidth).map((part) =>
    renderToolBackgroundLine(` ${part}`, width, background),
  );
}

function normalizeRenderedToolLine(text: string, width: number): string[] {
  return normalizeExternalRendererLines(text, width).map((part) => padLine(part, width));
}

function normalizeExternalRendererLines(text: string, width: number): string[] {
  return String(text)
    .split(/\r?\n/)
    .map((part) => truncateToWidth(sanitizeTerminalText(part).replace(/\t/g, "  "), Math.max(0, width), "..."));
}

function renderToolBackgroundLine(
  part: string,
  width: number,
  background: { start: string; end: string },
): string {
  const padded = padLine(part.replace(/\t/g, "  "), width);
  return `${background.start}${reapplyBackgroundAfterSgr(padded, background.start)}${background.end}`;
}

function reapplyBackgroundAfterSgr(text: string, backgroundStart: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*m/g, (sequence) => `${sequence}${backgroundStart}`);
}

function toolDisplayTitle(line: ChatLine): string {
  const name = line.title?.trim() || "tool";
  const args = objectRecord(line.args);
  if (name === "bash" && typeof args.command === "string" && args.command.trim())
    return `$ ${args.command.trim()}`;
  if (name === "read" && typeof args.path === "string" && args.path.trim())
    return `read ${args.path.trim()}`;
  if (name === "todo_write") return "todo_write";
  return name;
}

function toolBodyLines(line: ChatLine): string[] {
  const lines: string[] = [];
  const args = objectRecord(line.args);
  if (Object.keys(args).length > 0 && line.title !== "bash" && line.title !== "read") {
    lines.push("", ...prettyJson(args).split(/\r?\n/));
  }
  const text = line.text.trim();
  if (text) {
    lines.push(...(lines.length ? [""] : []), ...text.split(/\r?\n/));
  }
  return lines;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Render a skill invocation user message with a background box.
 * Collapsed: [skill] name (ctrl+o to expand)
 * Expanded: [skill] name + full skill content as markdown
 * User args (if any) are rendered as a separate user message block below.
 */
function renderSkillUserMessage(
  skillBlock: ParsedSkillBlock,
  width: number,
  tab?: MixCodeTabInfo,
): string[] {
  const expanded = tab?.extensionUi.toolsExpanded ?? false;
  const innerWidth = Math.max(1, width - 2);
  const lines: string[] = [];

  // Skill block with background box
  const boxLines: string[] = [];
  if (expanded) {
    // Expanded: [skill] label + name + full content
    const label = ` ${activeRenderTheme.bold("[skill]")} ${activeRenderTheme.bold(skillBlock.name)}`;
    boxLines.push("", label, "");
    const contentLines = renderMarkdown(skillBlock.content.trim(), innerWidth);
    for (const line of contentLines) boxLines.push(` ${line}`);
    boxLines.push("");
  } else {
    // Collapsed: [skill] name (ctrl+o to expand)
    const label = ` ${activeRenderTheme.bold("[skill]")} ${skillBlock.name} ${activeRenderTheme.dim("(ctrl+o to expand)")}`;
    boxLines.push("", label, "");
  }
  for (const part of boxLines) {
    lines.push(renderToolBackgroundLine(part, width, activeRenderTheme.customMessageBackground));
  }

  // Render user message (args) as a separate user block below
  if (skillBlock.userMessage) {
    lines.push(padLine("", width));
    const body = wrapPlainLine(skillBlock.userMessage, innerWidth).map((part) =>
      activeRenderTheme.userMessage(padLine(` ${part}`, width)),
    );
    lines.push(
      OSC133_ZONE_START + activeRenderTheme.userMessage(padLine("", width)),
      ...body,
      activeRenderTheme.userMessage(padLine("", width)) + OSC133_ZONE_END + OSC133_ZONE_FINAL,
    );
  }

  return lines;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function wrapPlainLine(text: string, width: number): string[] {
  return text.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width)));
}

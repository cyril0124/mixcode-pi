import type { ImageContent } from "@earendil-works/pi-ai";
import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  Image,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  currentExtensionTheme,
  ensureExtensionThemeInitialized,
} from "../../agent/runtime-extension-theme.js";
import type { ChatLine } from "../../agent/runtime.js";
import type { OversizedAssistantMessageSettings } from "../../core/mixcode-settings.js";
import type { MermaidRenderingMode, MixCodeTabInfo } from "../../core/types.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { formatDuration } from "./chrome.js";
import { renderMarkdown } from "./markdown.js";
import {
  isOversizedAssistantMessageText,
  renderOversizedAssistantMessageBlock,
} from "./oversized-assistant-message.js";
import { padLine, renderBackgroundLine, sanitizeTerminalText } from "./primitives.js";

/**
 * Parsed skill block from a user message.
 * Matches the format produced by Pi's native skill expansion
 * (AgentSession._expandSkillCommand):
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
// Complete messages render in full unless the TUI oversized policy folds them.
export const STREAMING_MARKDOWN_CHAR_LIMIT = 8000;
export interface RenderChatBlockOptions {
  oversizedAssistantMessage?: OversizedAssistantMessageSettings;
  streamingMarkdownCharLimit?: number;
  /** When true, thinking blocks collapse to a hidden form (label or placeholder). */
  hideThinking?: boolean;
  /** With hideThinking: render a boxed 3-row tail instead of the placeholder. */
  boxedHiddenThinking?: boolean;
  /** Pi `markdown.mermaid` mode. Default `streaming`. */
  mermaidRenderingMode?: MermaidRenderingMode;
  /** When false, user-message image blocks are hidden. Default true (Pi showImages). */
  showImages?: boolean;
  /** Max image width in terminal cells. Default 60 (Pi imageWidthCells). */
  imageWidthCells?: number;
  /**
   * Extension markdown transformers from `extensionRunner.getMarkdownTransformers()`.
   * Applied on user / assistant / thinking Markdown (Pi message types only).
   */
  markdownTransformers?: readonly MarkdownTransformer[];
}

// Fallback when a collapsed thinking block has no remaining text after stripping
// presentation artifacts. Pi's default hiddenThinkingLabel is the same string.
export const HIDDEN_THINKING_LABEL = "Thinking...";
const HIDDEN_THINKING_VIEWPORT_ROWS = 3;
const HIDDEN_THINKING_LABEL_PREFIX = /^(?:thinking:\s*)+/i;

interface RenderConversationOptions {
  blockOptions?: (line: ChatLine, index: number) => RenderChatBlockOptions | undefined;
}

const chatLineRenderCache = new WeakMap<ChatLine, { key: string; lines: string[] }>();

// Global render-input generation folded into every cache key. Bumped when an
// out-of-band render input changes (e.g. lazy highlight.js language
// registration completes), so cached blocks rendered before the change miss
// and re-render instead of pinning stale output.
let chatLineRenderGeneration = 0;

export function invalidateChatLineRenderCache(): void {
  chatLineRenderGeneration++;
}

export function renderConversation(
  chat: ChatLine[],
  width: number,
  tab?: MixCodeTabInfo,
  options: RenderConversationOptions = {},
): string[] {
  if (!chat.length) {
    return [
      padLine(activeRenderTheme.dim("No messages yet. Type a prompt and press Enter."), width),
      padLine("", width),
    ];
  }
  return renderChatStream(chat, width, tab, options.blockOptions);
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

function isPendingUserBash(line: ChatLine): boolean {
  return line.role === "tool" && line.variant === "user-bash" && line.pendingBash === true;
}

/**
 * Pi keeps streaming-started user bash after the main chat (pending zone).
 * Reorder only for display; session/chat storage order is unchanged.
 */
export function chatLinesForDisplay(chat: ChatLine[]): ChatLine[] {
  if (chat.length < 2) return chat;
  const mainLines: ChatLine[] = [];
  const pendingBashLines: ChatLine[] = [];
  for (const line of chat) {
    if (isPendingUserBash(line)) pendingBashLines.push(line);
    else mainLines.push(line);
  }
  if (pendingBashLines.length === 0) return chat;
  return [...mainLines, ...pendingBashLines];
}

/** Build original storage indices only when display ordering differs from chat ordering. */
export function originalChatIndicesForDisplay(
  chat: ChatLine[],
  displayChat: ChatLine[],
): Map<ChatLine, number> | undefined {
  if (displayChat === chat) return undefined;
  const indices = new Map<ChatLine, number>();
  for (let i = chat.length - 1; i >= 0; i--) indices.set(chat[i]!, i);
  return indices;
}

function renderChatStream(
  chat: ChatLine[],
  width: number,
  tab?: MixCodeTabInfo,
  blockOptions?: (line: ChatLine, index: number) => RenderChatBlockOptions | undefined,
): string[] {
  if (!chat.length) return [padLine(activeRenderTheme.dim("No messages yet."), width)];

  const ordered = chatLinesForDisplay(chat);
  const originalIndices = originalChatIndicesForDisplay(chat, ordered);
  if (ordered.length === 1) {
    return renderMessageBlock(ordered[0]!, width, tab, blockOptions?.(ordered[0]!, 0));
  }

  // Render each block (per-line cache hits keep this cheap for unchanged lines).
  const blocks = new Array<string[]>(ordered.length);
  let totalLength = 0;
  let nonEmptyCount = 0;
  for (let i = 0; i < ordered.length; i++) {
    const line = ordered[i]!;
    // blockOptions still sees original chat indices when provided.
    const originalIndex = originalIndices?.get(line) ?? i;
    const block = renderMessageBlock(line, width, tab, blockOptions?.(line, originalIndex));
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
  const rawKey = chatLineRenderCacheKey(line, width, tab, options);
  const cacheKey = rawKey && `${chatLineRenderGeneration}${KEY_SEP}${rawKey}`;
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
    const images = line.images ?? [];
    if (!text.trim() && images.length === 0) return [];
    // Detect skill block and render collapsed/expanded
    const skillBlock = text.trim() ? parseSkillBlock(text) : null;
    if (skillBlock) {
      return renderSkillUserMessage(skillBlock, width, tab, line.timestamp, options, images);
    }
    return renderUserMessageBlock(text, width, line.timestamp, options, images);
  }
  if (line.role === "assistant") {
    if (!text.trim()) return [];
    const trimmed = text.trim();
    const oversized = renderOversizedAssistantMessageBlock(
      line.role,
      trimmed,
      options.oversizedAssistantMessage,
      width,
    );
    if (oversized) return withOsc133Zone(oversized);
    return withOsc133Zone(
      renderMarkdown(streamingMarkdownText(trimmed, options), width, {
        mermaidRenderingMode: options.mermaidRenderingMode,
        messageType: "assistant",
        isStreaming: options.streamingMarkdownCharLimit !== undefined,
        transformers: options.markdownTransformers,
      }),
    );
  }
  if (line.role === "thinking") {
    if (!text.trim()) return [];
    // Hidden: extension label, else boxed 3-row tail (opt-in) or placeholder.
    if (options.hideThinking) {
      const label = tab?.extensionUi.hiddenThinkingLabel?.trim();
      if (label) {
        return renderMarkdown(label, width, {
          color: activeRenderTheme.thinkingText,
          italic: true,
          mermaidRenderingMode: options.mermaidRenderingMode,
          messageType: "assistant-thinking",
          isStreaming: options.streamingMarkdownCharLimit !== undefined,
          transformers: options.markdownTransformers,
        });
      }
      if (!options.boxedHiddenThinking) {
        return renderMarkdown(HIDDEN_THINKING_LABEL, width, {
          color: activeRenderTheme.thinkingText,
          italic: true,
          messageType: "assistant-thinking",
        });
      }
      return renderHiddenThinkingViewport(
        text,
        width,
        HIDDEN_THINKING_VIEWPORT_ROWS,
        thinkingDurationLabel(line, options),
      );
    }
    const trimmed = text.trim();
    const oversized = renderOversizedAssistantMessageBlock(
      line.role,
      trimmed,
      options.oversizedAssistantMessage,
      width,
    );
    if (oversized) return oversized;
    return renderMarkdown(streamingMarkdownText(trimmed, options), width, {
      color: activeRenderTheme.thinkingText,
      italic: true,
      mermaidRenderingMode: options.mermaidRenderingMode,
      messageType: "assistant-thinking",
      isStreaming: options.streamingMarkdownCharLimit !== undefined,
      transformers: options.markdownTransformers,
    });
  }
  if (line.role === "tool") {
    return renderToolBlock(line, width, tab);
  }
  if (line.role === "extension") {
    return renderExtensionBlock(line, width);
  }
  if (line.branchSummary) {
    return renderBranchSummaryBlock(text, width, tab);
  }
  if (line.compactionSummary) {
    return renderCompactionSummaryBlock(text, width, line.compactionTokensBefore, tab);
  }
  return renderSystemBlock(text, width, line.variant, line.systemStatus === true);
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
  options: RenderChatBlockOptions = {},
): string | undefined {
  // Dynamic renderers must execute every frame for lifecycle correctness.
  if (line.renderExtension || line.renderToolCall) return undefined;
  const themeName = activeRenderTheme.name;
  const role = line.role;

  // Hot paths first (assistant/thinking dominate any long chat).
  if (role === "assistant" || role === "thinking") {
    if (isOversizedAssistantMessageText(line.text, options.oversizedAssistantMessage)) {
      return undefined;
    }
    // hideThinking + custom label + boxed style + live timer flip the collapsed thinking render.
    const hideKey =
      role === "thinking" && options.hideThinking
        ? `1${KEY_SEP}${tab?.extensionUi.hiddenThinkingLabel ?? ""}${KEY_SEP}${options.boxedHiddenThinking ? 1 : 0}${KEY_SEP}${thinkingDurationLabel(line, options)}`
        : "0";
    const mermaidKey = options.mermaidRenderingMode ?? "streaming";
    const transformersKey = markdownTransformersCacheKey(options.markdownTransformers);
    return `${role[0]}${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${oversizedPolicyKey(options)}${KEY_SEP}${hideKey}${KEY_SEP}${mermaidKey}${KEY_SEP}${transformersKey}${KEY_SEP}${line.text}`;
  }
  const expanded = tab?.extensionUi.toolsExpanded ?? false;
  if (role === "user") {
    // Skill blocks switch on toolsExpanded; images / showImages flip the image strip.
    const showImages = options.showImages === false ? 0 : 1;
    const imageKey = userImagesCacheKey(line.images);
    const mermaidKey = options.mermaidRenderingMode ?? "streaming";
    const transformersKey = markdownTransformersCacheKey(options.markdownTransformers);
    return `u${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${expanded ? 1 : 0}${KEY_SEP}${line.timestamp ?? ""}${KEY_SEP}${showImages}${KEY_SEP}${options.imageWidthCells ?? 60}${KEY_SEP}${mermaidKey}${KEY_SEP}${transformersKey}${KEY_SEP}${imageKey}${KEY_SEP}${line.text}`;
  }
  if (role === "extension") {
    return `e${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${line.title ?? ""}${KEY_SEP}${line.customType ?? ""}${KEY_SEP}${line.text}`;
  }
  if (role === "tool") {
    if (line.variant === "user-bash") {
      // user-bash branch reads almost every bash-related field plus the
      // global toolsExpanded toggle. Esc-hint also depends on whether the
      // agent is busy (Esc aborts agent).
      const agentBusy = tab?.status === "running" || tab?.status === "thinking" ? 1 : 0;
      return `ub${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${line.status ?? ""}${KEY_SEP}${line.title ?? ""}${KEY_SEP}${commandFromArgs(line.args)}${KEY_SEP}${line.excludeFromContext === true ? 1 : 0}${KEY_SEP}${line.pendingBash === true ? 1 : 0}${KEY_SEP}${line.bashExitCode ?? ""}${KEY_SEP}${line.bashCancelled === true ? 1 : 0}${KEY_SEP}${line.bashTruncated === true ? 1 : 0}${KEY_SEP}${line.bashFullOutputPath ?? ""}${KEY_SEP}${expanded ? 1 : 0}${KEY_SEP}${agentBusy}${KEY_SEP}${line.text}`;
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
  return `s${KEY_SEP}${themeName}${KEY_SEP}${width}${KEY_SEP}${line.variant ?? ""}${KEY_SEP}${line.systemStatus ? 1 : 0}${KEY_SEP}${line.text}`;
}

function oversizedPolicyKey(options: RenderChatBlockOptions): string {
  const policy = options.oversizedAssistantMessage;
  if (!policy) return "";
  return `${policy.enabled ? 1 : 0}:${policy.maxLines}:${policy.maxBytes}`;
}

// Stable identity for transformer functions so line-cache keys stay valid while
// the same extension list is loaded, and invalidate when the list is replaced.
const markdownTransformerIdentity = new WeakMap<MarkdownTransformer, number>();
let nextMarkdownTransformerId = 1;

function markdownTransformersCacheKey(
  transformers: readonly MarkdownTransformer[] | undefined,
): string {
  if (!transformers?.length) return "0";
  return transformers
    .map((transformer) => {
      let id = markdownTransformerIdentity.get(transformer);
      if (id === undefined) {
        id = nextMarkdownTransformerId++;
        markdownTransformerIdentity.set(transformer, id);
      }
      return String(id);
    })
    .join(",");
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
  if (line.renderToolCall) {
    const selfRendered = line.toolRenderShell === "self";
    const renderedWidth = selfRendered ? width : Math.max(1, width - 2);
    const rendered = line.renderToolCall(renderedWidth);
    if (rendered.length) {
      // Pi stacks chat components with no stream-level separator: each component owns
      // its leading gap, so ToolExecutionComponent opens with a Spacer(1) blank row.
      // MixCode owns spacing at the stream level instead (one separator between blocks),
      // so keeping Pi's spacer double-counts the gap above every tool block.
      if (rendered[0] === "") rendered.shift();
      if (selfRendered) return rendered.flatMap((part) => normalizeRenderedToolLine(part, width));
      return ["", ...rendered, ""].flatMap((part) => renderToolRenderedLine(line, part, width));
    }
  }
  const status = line.status ?? "success";
  const background =
    status === "error"
      ? activeRenderTheme.toolErrorBg
      : status === "success"
        ? activeRenderTheme.toolSuccessBg
        : activeRenderTheme.toolPendingBg;
  const innerWidth = Math.max(1, width - 2);
  const titleColor =
    status === "error"
      ? activeRenderTheme.error
      : status === "success"
        ? activeRenderTheme.success
        : activeRenderTheme.toolTitle;
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
  return lines.map((part) => renderBackgroundLine(part, width, background));
}

function renderUserBashBlock(line: ChatLine, width: number, tab?: MixCodeTabInfo): string[] {
  const innerWidth = Math.max(1, width - 1);
  const color = line.excludeFromContext ? activeRenderTheme.dim : activeRenderTheme.bashMode;
  const title = color(activeRenderTheme.bold(toolDisplayTitle(line)));
  const output = line.text.trimEnd();
  const outputLines = output ? output.split(/\r?\n/) : [];
  const expanded = tab?.extensionUi.toolsExpanded === true;
  // Overflow count is relative to the collapsed preview budget, not the currently
  // visible slice — so expanded views can still show "ctrl+o to collapse".
  const overflowLineCount = Math.max(0, outputLines.length - USER_BASH_PREVIEW_LINES);
  const visibleOutput = expanded
    ? outputLines
    : outputLines.slice(Math.max(0, outputLines.length - USER_BASH_PREVIEW_LINES));
  const body: string[] = [userBashRule(width, color), ` ${title}`];
  if (visibleOutput.length) {
    body.push(
      "",
      ...visibleOutput.flatMap((item) =>
        wrapTextWithAnsi(item || " ", innerWidth).map((part) => ` ${activeRenderTheme.dim(part)}`),
      ),
    );
  }
  const statusLines = userBashStatusLines(line, overflowLineCount, expanded, tab);
  if (statusLines.length) body.push("", ...statusLines.map((part) => ` ${part}`));
  body.push(userBashRule(width, color));
  return body.map((part) => padLine(part, width));
}

function userBashRule(width: number, color = activeRenderTheme.toolTitle): string {
  return color("─".repeat(Math.max(1, width)));
}

function userBashStatusLines(
  line: ChatLine,
  overflowLineCount: number,
  expanded: boolean,
  tab?: MixCodeTabInfo,
): string[] {
  const lines: string[] = [];
  if (overflowLineCount > 0) {
    const label = expanded
      ? "(ctrl+o to collapse)"
      : `... ${overflowLineCount} more lines (ctrl+o to expand)`;
    lines.push(activeRenderTheme.dim(label));
  }
  if (line.status === "running") {
    // While the agent is streaming/working, Esc is claimed by abort-agent, not bash cancel.
    const agentBusy = tab?.status === "running" || tab?.status === "thinking";
    lines.push(
      activeRenderTheme.dim(
        agentBusy ? "Running... (agent Esc aborts run)" : "Running... (Esc to cancel)",
      ),
    );
  }
  if (line.status !== "running" && line.bashCancelled === true) {
    lines.push(activeRenderTheme.warning("(cancelled)"));
  } else if (
    line.status !== "running" &&
    line.bashExitCode !== undefined &&
    line.bashExitCode !== 0
  ) {
    lines.push(activeRenderTheme.error(`(exit ${line.bashExitCode})`));
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

function renderSystemBlock(
  text: string,
  width: number,
  variant?: string,
  systemStatus = false,
): string[] {
  const body = text.trim() ? text.trim() : " ";
  const isError = variant === "system-error" || text.startsWith("Error:");
  const isWarning = variant === "system-warning";
  const isPlain = variant === "system-plain";
  // Pi notify/status/warning/error/session dump use plain Text with one leading
  // space of padding and no trailing blank line. Outer chat composition already
  // inserts one blank line between non-empty blocks.
  if (isError || isWarning || systemStatus) {
    const color = isError
      ? activeRenderTheme.error
      : isWarning
        ? activeRenderTheme.warning
        : activeRenderTheme.dim;
    return wrapPlainLine(body, Math.max(1, width - 1)).map((part) =>
      padLine(` ${color(part)}`, width),
    );
  }
  if (isPlain) {
    // Pi handleSessionCommand: bold section titles, dim "Label:" prefixes, normal values.
    return renderSystemPlainDump(body, width);
  }
  // Permanent system blocks (e.g. /help) keep Markdown and surrounding spacing.
  const lines = [
    "",
    ...renderMarkdown(body, Math.max(1, width - 1), { color: activeRenderTheme.dim }),
    "",
  ];
  return lines.map((part) => padLine(part, width));
}

function renderBranchSummaryBlock(text: string, width: number, tab?: MixCodeTabInfo): string[] {
  const expanded = tab?.extensionUi.toolsExpanded ?? false;
  const title = activeRenderTheme.accent(activeRenderTheme.bold("[branch]"));
  const lines: string[] = ["", ` ${title}`];
  if (expanded) {
    lines.push(
      "",
      ...renderMarkdown(text.trim(), Math.max(1, width - 1)).map((line) => ` ${line}`),
    );
  } else {
    lines.push(` ${activeRenderTheme.dim("Branch summary (ctrl+o to expand)")}`);
  }
  lines.push("");
  return lines.map((part) => renderBackgroundLine(part, width, activeRenderTheme.systemBackground));
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
    lines.push(` ${activeRenderTheme.dim(`${tokenInfo} (ctrl+o to expand)`)}`);
  }
  lines.push("");
  return lines.map((part) => renderBackgroundLine(part, width, activeRenderTheme.systemBackground));
}

/**
 * Render the tab-level startup resource summary ([Context]/[Skills]/...).
 * Called from the agent surface header slot, not the chat block renderer —
 * the summary is no longer a chat line.
 */
export function renderStartupBlock(text: string, width: number): string[] {
  // Pi renders the [Skill conflicts] block in a prominent warning color, unlike
  // the muted tool color used for informational sections. Track whether we are
  // inside that block so its header and content lines stand out.
  let inSkillConflicts = false;
  return text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inSkillConflicts = trimmed === "[Skill conflicts]";
      const headerColor = inSkillConflicts
        ? activeRenderTheme.warning
        : activeRenderTheme.toolTitle;
      return [padLine(headerColor(trimmed), width)];
    }
    // Wrap long resource lists (e.g. comma-separated skills/extensions) so the
    // full content stays visible instead of being clipped with an ellipsis.
    // Continuation lines keep the original leading indent (hanging indent).
    const indent = line.match(/^\s*/)?.[0] ?? "";
    const content = line.slice(indent.length);
    const wrapWidth = Math.max(1, width - indent.length);
    if (inSkillConflicts && content.length > 0) {
      return renderSkillConflictLine(indent, content, wrapWidth, width);
    }
    return wrapTextWithAnsi(content, wrapWidth).map((part) =>
      padLine(activeRenderTheme.dim(`${indent}${part}`), width),
    );
  });
}

/**
 * Color a single line inside the [Skill conflicts] block, mirroring Pi's
 * formatDiagnostics: winner (✓) uses success, loser (✗) uses warning, and
 * collision-name / diagnostic-path lines use warning for prominence. Only the
 * first wrapped part carries the marker; continuation parts stay dim.
 */
function renderSkillConflictLine(
  indent: string,
  content: string,
  wrapWidth: number,
  width: number,
): string[] {
  return wrapTextWithAnsi(content, wrapWidth).map((part, index) => {
    if (index > 0) return padLine(activeRenderTheme.dim(`${indent}${part}`), width);
    if (part.startsWith("✓ ")) {
      return padLine(
        `${indent}${activeRenderTheme.success("✓")} ${activeRenderTheme.dim(part.slice(2))}`,
        width,
      );
    }
    if (part.startsWith("✗ ")) {
      return padLine(
        `${indent}${activeRenderTheme.warning("✗")} ${activeRenderTheme.dim(part.slice(2))}`,
        width,
      );
    }
    return padLine(activeRenderTheme.warning(`${indent}${part}`), width);
  });
}

function normalizeRenderedExtensionLine(line: string, width: number): string[] {
  return normalizeExternalRendererLines(line, width).map((part) => padLine(part, width));
}

function renderToolRenderedLine(line: ChatLine, text: string, width: number): string[] {
  const status = line.status ?? "success";
  const background =
    status === "error"
      ? activeRenderTheme.toolErrorBg
      : status === "success"
        ? activeRenderTheme.toolSuccessBg
        : activeRenderTheme.toolPendingBg;
  const innerWidth = Math.max(1, width - 1);
  return normalizeExternalRendererLines(text, innerWidth).map((part) =>
    renderBackgroundLine(` ${part}`, width, background),
  );
}

function normalizeRenderedToolLine(text: string, width: number): string[] {
  return normalizeExternalRendererLines(text, width).map((part) => padLine(part, width));
}

function normalizeExternalRendererLines(text: string, width: number): string[] {
  return String(text)
    .split(/\r?\n/)
    .map((part) =>
      truncateToWidth(sanitizeTerminalText(part).replace(/\t/g, "  "), Math.max(0, width), "..."),
    );
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
 * Pi UserMessageComponent: Markdown body + userMessageBg pad, plus MixCode clock.
 * Image blocks (when present) render after the text box, matching tool-result image strip.
 */
function renderUserMessageBlock(
  text: string,
  width: number,
  timestamp: number | undefined,
  options: RenderChatBlockOptions,
  images: ImageContent[] = [],
): string[] {
  ensureExtensionThemeInitialized();
  const theme = currentExtensionTheme();
  const clock = formatUserMessageTime(timestamp);
  const clockWidth = clock ? visibleWidth(` ${clock}`) : 0;
  const mdWidth = Math.max(1, width - clockWidth);
  const mdLines = text.trim()
    ? renderMarkdown(text.trimEnd(), mdWidth, {
        color: (content) => theme.fg("userMessageText", content),
        messageType: "user",
        mermaidRenderingMode: options.mermaidRenderingMode,
        transformers: options.markdownTransformers,
        // Match Pi UserMessageComponent Markdown options.
        preserveOrderedListMarkers: true,
        preserveBackslashEscapes: true,
      })
    : [];
  const body =
    mdLines.length > 0
      ? mdLines.map((part, index) =>
          index === 0 && clock
            ? activeRenderTheme.userMessageBg(
                padLine(withRightClock(part.replace(/\s+$/u, ""), clock, width, true), width),
              )
            : activeRenderTheme.userMessageBg(padLine(part, width)),
        )
      : [];
  const imageLines = renderUserMessageImages(images, width, options);
  if (body.length === 0 && imageLines.length === 0) return [];
  return [
    OSC133_ZONE_START + activeRenderTheme.userMessageBg(padLine("", width)),
    ...body,
    activeRenderTheme.userMessageBg(padLine("", width)) + OSC133_ZONE_END + OSC133_ZONE_FINAL,
    ...imageLines,
  ];
}

function renderUserMessageImages(
  images: ImageContent[],
  width: number,
  options: RenderChatBlockOptions,
): string[] {
  if (options.showImages === false || images.length === 0) return [];
  const caps = getCapabilities();
  const maxWidthCells = Math.max(1, options.imageWidthCells ?? 60);
  const lines: string[] = [];
  for (const img of images) {
    if (!img.data || !img.mimeType) continue;
    // Kitty only embeds PNG; skip other mime types like Pi ToolExecutionComponent.
    if (caps.images === "kitty" && img.mimeType !== "image/png") continue;
    const component = new Image(
      img.data,
      img.mimeType,
      { fallbackColor: (s) => activeRenderTheme.dim(s) },
      { maxWidthCells },
    );
    lines.push(...component.render(width));
  }
  return lines;
}

function userImagesCacheKey(images: ImageContent[] | undefined): string {
  if (!images?.length) return "0";
  return images
    .map((img) => `${img.mimeType}:${img.data.length}:${img.data.slice(0, 12)}`)
    .join(",");
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
  timestamp?: number,
  options: RenderChatBlockOptions = {},
  images: ImageContent[] = [],
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
  // Skill-only (no args): pin clock on the label line, keep blank top spacing.
  const skillClock = !skillBlock.userMessage ? formatUserMessageTime(timestamp) : "";
  if (skillClock && boxLines[1]) {
    boxLines[1] = withRightClock(boxLines[1]!, skillClock, width);
  }
  for (const part of boxLines) {
    lines.push(renderBackgroundLine(part, width, activeRenderTheme.customMessageBg));
  }

  // Render user message (args) as a separate user block below (Markdown + images).
  if (skillBlock.userMessage || images.length > 0) {
    lines.push(padLine("", width));
    lines.push(
      ...renderUserMessageBlock(skillBlock.userMessage ?? "", width, timestamp, options, images),
    );
  }

  return lines;
}

function formatUserMessageTime(timestamp?: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "";
  // Short month/day + local clock, e.g. "Aug 9, 5:07 PM" (locale-dependent).
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Pack `left` + right-aligned clock into `width`.
 * When `dimClock` is set, only the clock gets dim SGR (body stays normal).
 */
function withRightClock(left: string, clock: string, width: number, dimClock = false): string {
  const right = truncateToWidth(` ${clock}`, Math.max(0, width));
  const rightWidth = visibleWidth(right);
  const leftBudget = Math.max(0, width - rightWidth);
  const clippedLeft = truncateToWidth(left, leftBudget);
  const fill = Math.max(0, width - visibleWidth(clippedLeft) - rightWidth);
  const styledRight = dimClock ? activeRenderTheme.dim(right) : right;
  return `${clippedLeft}${" ".repeat(fill)}${styledRight}`;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Pi-style plain dump: bold headers, dim labels, normal values. */
function renderSystemPlainDump(body: string, width: number): string[] {
  const innerWidth = Math.max(1, width - 1);
  const sectionHeaders = new Set(["Session Info", "Messages", "Tokens", "Cost"]);
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    if (!raw.trim()) {
      lines.push(padLine("", width));
      continue;
    }
    const trimmed = raw.trimEnd();
    if (sectionHeaders.has(trimmed) && !/^\s/.test(raw)) {
      const styled = activeRenderTheme.bold(trimmed);
      for (const part of wrapTextWithAnsi(styled, innerWidth)) {
        lines.push(padLine(` ${part}`, width));
      }
      continue;
    }
    const match = raw.match(/^(\s*)([^:]+:)(\s*)(.*)$/);
    if (match) {
      const indent = match[1] ?? "";
      const label = match[2] ?? "";
      const value = match[4] ?? "";
      const styled =
        `${indent}${activeRenderTheme.dim(label)}` +
        (value.length > 0 ? ` ${activeRenderTheme.text(value)}` : "");
      for (const part of wrapTextWithAnsi(styled, innerWidth)) {
        lines.push(padLine(` ${part}`, width));
      }
      continue;
    }
    for (const part of wrapTextWithAnsi(activeRenderTheme.text(raw), innerWidth)) {
      lines.push(padLine(` ${part}`, width));
    }
  }
  return lines;
}

function wrapPlainLine(text: string, width: number): string[] {
  return text.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width)));
}

function stripHiddenThinkingPresentation(text: string): string {
  let current = text.replace(/\x1b\[[0-9;]*m/g, "");
  while (true) {
    const withoutLabel = current.replace(HIDDEN_THINKING_LABEL_PREFIX, "").trimStart();
    if (withoutLabel === current) return current.trim();
    current = withoutLabel;
  }
}

function tailVisualRows(
  text: string,
  width: number,
  maxRows: number,
): { rows: string[]; overflow: boolean } {
  const colWidth = Math.max(1, width);
  const charBudget = maxRows * colWidth;
  const sourceLines = text.split(/\r?\n/);
  const visual: string[] = [];
  let overflow = false;
  for (let index = sourceLines.length - 1; index >= 0; index--) {
    const line = sourceLines[index] ?? "";
    // ponytail: wrap only a tail of each source line; wrapping a 100k-char line is O(n).
    const piece = line.length > charBudget ? line.slice(-charBudget) : line;
    if (line.length > charBudget) overflow = true;
    visual.unshift(...wrapPlainLine(piece || " ", colWidth));
    if (visual.length >= maxRows) {
      overflow = overflow || index > 0 || visual.length > maxRows;
      return { rows: visual.slice(-maxRows), overflow };
    }
  }
  return { rows: visual, overflow };
}

function renderThinkingCard(lines: string[], chatWidth: number, duration = ""): string[] {
  const innerWidth = Math.max(1, chatWidth - 2);
  const paint = activeRenderTheme.thinkingText;
  const label = `─ Thinking${duration} `;
  const fill = Math.max(0, innerWidth - visibleWidth(label));
  const top = paint(`╭${label}${"─".repeat(fill)}╮`);
  const body = lines.map((line) => `${paint("│")}${padLine(line, innerWidth)}${paint("│")}`);
  const bottom = paint(`╰${"─".repeat(innerWidth)}╯`);
  return [top, ...body, bottom].map((line) => padLine(line, chatWidth));
}

function renderHiddenThinkingViewport(
  text: string,
  width: number,
  maxRows: number,
  duration = "",
): string[] {
  const stripped = stripHiddenThinkingPresentation(text);
  if (!stripped) {
    return renderMarkdown(HIDDEN_THINKING_LABEL, width, {
      color: activeRenderTheme.thinkingText,
      italic: true,
      messageType: "assistant-thinking",
    });
  }
  const innerWidth = Math.max(1, width - 2);
  const textWidth = Math.max(1, innerWidth - 1);
  const { rows, overflow } = tailVisualRows(stripped, textWidth, maxRows);
  const style = (body: string) => activeRenderTheme.italic(activeRenderTheme.thinkingText(body));
  const lines = rows.map((row, index) => {
    if (index === 0 && overflow) {
      const marker = "\u2026 ";
      const budget = Math.max(1, textWidth - visibleWidth(marker));
      return ` ${style(`${marker}${truncateToWidth(row, budget, "", true)}`)}`;
    }
    return ` ${style(row)}`;
  });
  return renderThinkingCard(lines, width, duration);
}

/**
 * Boxed-tail timer: milliseconds below 1s, tenths while live, hundredths when
 * frozen, and whole-second minute/hour labels from 60s. Live seconds truncate
 * to 100ms buckets; the label also keys the render cache. Unstamped history
 * and non-streaming blocks without an end stamp have no timer.
 */
function thinkingDurationLabel(line: ChatLine, options: RenderChatBlockOptions): string {
  const started = line.thinkingStartedAt;
  if (started === undefined) return "";
  const ended = line.thinkingEndedAt;
  if (ended === undefined && options.streamingMarkdownCharLimit === undefined) return "";
  const elapsed = Math.max(0, (ended ?? Date.now()) - started);
  if (elapsed < 1000) return ` · ${elapsed}ms`;
  if (elapsed < 60_000) {
    if (ended === undefined) return ` · ${(Math.floor(elapsed / 100) / 10).toFixed(1)}s`;
    // Clamp below the minute boundary so hundredths rounding cannot print 60.00s.
    const seconds = Math.min(elapsed, 59_994) / 1000;
    return ` · ${seconds.toFixed(2)}s`;
  }
  return ` · ${formatDuration(Math.floor(elapsed / 1000))}`;
}

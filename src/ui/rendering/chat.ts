import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ChatLine } from "../../agent/runtime.js";
import type { MixCodeTabInfo } from "../../core/types.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { renderMarkdown } from "./markdown.js";
import { padLine } from "./primitives.js";

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

const TOOL_BACKGROUNDS = {
  pending: { start: "\x1b[48;2;47;42;34m", end: "\x1b[49m" },
  success: { start: "\x1b[48;2;38;38;36m", end: "\x1b[49m" },
  error: { start: "\x1b[48;2;58;32;32m", end: "\x1b[49m" },
} as const;
const SYSTEM_BACKGROUND = { start: "\x1b[48;2;35;35;33m", end: "\x1b[49m" } as const;
// Skill block background: dark purple-tinted (#2d2838), matching Pi reference customMessageBg
const SKILL_BACKGROUND = { start: "\x1b[48;2;45;40;56m", end: "\x1b[49m" } as const;
const USER_BASH_PREVIEW_LINES = 20;
const chatLineRenderCache = new WeakMap<ChatLine, { key: string; lines: string[] }>();

export function renderChat(
  chat: ChatLine[],
  width: number,
  theme = activeRenderTheme,
  tab?: MixCodeTabInfo,
): string[] {
  return renderWithTheme(theme, () => renderChatStream(chat, width, tab));
}

export function renderThinking(
  reasoning: string[],
  width: number,
  theme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderReasoningSummary(reasoning, width));
}

export function renderConversation(
  chat: ChatLine[],
  reasoning: string[],
  width: number,
  tab?: MixCodeTabInfo,
): string[] {
  if (!chat.length && !reasoning.length) {
    return [
      padLine(activeRenderTheme.dim("No messages yet. Type a prompt and press Enter."), width),
      padLine("", width),
    ];
  }
  const reasoningSummary = chat.some((line) => line.role === "thinking")
    ? []
    : renderReasoningSummary(reasoning, width, tab);
  return [...reasoningSummary, ...renderChatStream(chat, width, tab)];
}

function renderReasoningSummary(
  reasoning: string[],
  width: number,
  tab?: MixCodeTabInfo,
): string[] {
  if (!reasoning.length) return [];
  const entries = reasoning
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-3);
  const label = tab?.extensionUi.hiddenThinkingLabel?.trim();
  const labeledEntries = label ? [`${label} ${entries.at(-1) ?? ""}`.trim()] : entries;
  const lines = labeledEntries.flatMap((line) =>
    renderMarkdown(line, width, { color: activeRenderTheme.thinking, italic: true }),
  );
  return [...lines, padLine("", width)];
}

// Cache rendered lines for all messages except the last one.
// During streaming, only the last message changes, so the prefix is stable.
interface ChatPrefixCache {
  lines: string[];
  // Invalidation keys
  chatRef: ChatLine[];
  prefixLength: number; // chat.length - 1
  width: number;
  themeName: string;
  toolsExpanded: boolean;
}

const chatPrefixCacheMap = new WeakMap<ChatLine[], ChatPrefixCache>();

function renderChatStream(chat: ChatLine[], width: number, tab?: MixCodeTabInfo): string[] {
  if (!chat.length) return [padLine(activeRenderTheme.dim("No messages yet."), width)];
  if (chat.length === 1) {
    return renderMessageBlock(chat[0]!, width, tab);
  }

  // Try to reuse cached prefix (all messages except the last)
  const prefixLength = chat.length - 1;
  const toolsExpanded = tab?.extensionUi.toolsExpanded ?? false;
  const cached = chatPrefixCacheMap.get(chat);
  let prefixLines: string[];

  if (
    cached &&
    cached.chatRef === chat &&
    cached.prefixLength === prefixLength &&
    cached.width === width &&
    cached.themeName === activeRenderTheme.name &&
    cached.toolsExpanded === toolsExpanded
  ) {
    prefixLines = cached.lines;
  } else {
    // Render all messages except the last
    prefixLines = [];
    for (let i = 0; i < prefixLength; i++) {
      if (i > 0) prefixLines.push(padLine("", width));
      const block = renderMessageBlock(chat[i]!, width, tab);
      for (let j = 0; j < block.length; j++) prefixLines.push(block[j]!);
    }
    chatPrefixCacheMap.set(chat, {
      lines: prefixLines,
      chatRef: chat,
      prefixLength,
      width,
      themeName: activeRenderTheme.name,
      toolsExpanded,
    });
  }

  // Render the last message (may be streaming)
  const lastBlock = renderMessageBlock(chat[prefixLength]!, width, tab);
  const result = new Array(prefixLines.length + 1 + lastBlock.length);
  for (let i = 0; i < prefixLines.length; i++) result[i] = prefixLines[i];
  result[prefixLines.length] = padLine("", width); // separator
  for (let i = 0; i < lastBlock.length; i++) result[prefixLines.length + 1 + i] = lastBlock[i];
  return result;
}

function renderMessageBlock(line: ChatLine, width: number, tab?: MixCodeTabInfo): string[] {
  const cacheKey = chatLineRenderCacheKey(line, width, tab);
  if (cacheKey) {
    const cached = chatLineRenderCache.get(line);
    if (cached?.key === cacheKey) return cached.lines;
    const rendered = renderMessageBlockUncached(line, width, tab);
    chatLineRenderCache.set(line, { key: cacheKey, lines: rendered });
    return rendered;
  }
  return renderMessageBlockUncached(line, width, tab);
}

function renderMessageBlockUncached(line: ChatLine, width: number, tab?: MixCodeTabInfo): string[] {
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
      activeRenderTheme.userMessage(padLine("", width)),
      ...body,
      activeRenderTheme.userMessage(padLine("", width)),
    ];
  }
  if (line.role === "assistant") {
    if (!text.trim()) return [];
    return renderMarkdown(text.trim(), width);
  }
  if (line.role === "thinking") {
    if (!text.trim()) return [];
    return renderMarkdown(text.trim(), width, { color: activeRenderTheme.thinking, italic: true });
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
  return renderSystemBlock(text, width);
}

function chatLineRenderCacheKey(
  line: ChatLine,
  width: number,
  tab?: MixCodeTabInfo,
): string | undefined {
  if (line.renderExtension || line.renderToolCall || line.renderToolResult) return undefined;
  if (
    line.role !== "assistant" &&
    line.role !== "thinking" &&
    line.role !== "user" &&
    line.role !== "system" &&
    line.role !== "startup"
  )
    return undefined;
  if (
    line.title !== undefined ||
    line.variant !== undefined ||
    line.customType !== undefined ||
    line.status !== undefined ||
    line.toolCallId !== undefined ||
    line.args !== undefined ||
    line.toolResult !== undefined ||
    line.toolIsPartial !== undefined ||
    line.toolExpanded !== undefined ||
    line.excludeFromContext !== undefined ||
    line.bashExitCode !== undefined ||
    line.bashCancelled !== undefined ||
    line.bashTruncated !== undefined ||
    line.bashFullOutputPath !== undefined ||
    line.branchSummary !== undefined
  )
    return undefined;
  // Include toolsExpanded for user messages that may contain skill blocks
  const expanded = tab?.extensionUi.toolsExpanded ?? false;
  return JSON.stringify([activeRenderTheme.name, width, line.role, line.text, expanded]);
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
      ? TOOL_BACKGROUNDS.error
      : status === "success"
        ? TOOL_BACKGROUNDS.success
        : TOOL_BACKGROUNDS.pending;
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

function renderSystemBlock(text: string, width: number): string[] {
  const body = text.trim() ? text.trim() : " ";
  const title = activeRenderTheme.accent(activeRenderTheme.bold("[System]:"));
  const lines = [
    "",
    ` ${title}`,
    ...renderMarkdown(body, Math.max(1, width - 1)).map((line) => ` ${line}`),
    "",
  ];
  return lines.map((part) => renderToolBackgroundLine(part, width, SYSTEM_BACKGROUND));
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
  return lines.map((part) => renderToolBackgroundLine(part, width, SYSTEM_BACKGROUND));
}

function renderStartupBlock(text: string, width: number): string[] {
  return text.split(/\r?\n/).map((line) => {
    if (/^\[[^\]]+\]$/.test(line.trim())) {
      return padLine(activeRenderTheme.tool(line.trim()), width);
    }
    return padLine(activeRenderTheme.dim(line), width);
  });
}

function normalizeRenderedExtensionLine(line: string, width: number): string[] {
  return String(line)
    .split(/\r?\n/)
    .map((part) => padLine(part.replace(/\t/g, "  "), width));
}

function renderToolRenderedLine(line: ChatLine, text: string, width: number): string[] {
  const status = line.status ?? "success";
  const background =
    status === "error"
      ? TOOL_BACKGROUNDS.error
      : status === "success"
        ? TOOL_BACKGROUNDS.success
        : TOOL_BACKGROUNDS.pending;
  return String(text)
    .split(/\r?\n/)
    .map((part) => renderToolBackgroundLine(` ${part}`, width, background));
}

function normalizeRenderedToolLine(text: string, width: number): string[] {
  return String(text)
    .split(/\r?\n/)
    .map((part) => padLine(part.replace(/\t/g, "  "), width));
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
    lines.push(renderToolBackgroundLine(part, width, SKILL_BACKGROUND));
  }

  // Render user message (args) as a separate user block below
  if (skillBlock.userMessage) {
    lines.push(padLine("", width));
    const body = wrapPlainLine(skillBlock.userMessage, innerWidth).map((part) =>
      activeRenderTheme.userMessage(padLine(` ${part}`, width)),
    );
    lines.push(
      activeRenderTheme.userMessage(padLine("", width)),
      ...body,
      activeRenderTheme.userMessage(padLine("", width)),
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

// ╔══════════════════════════════════════════════════════════════════╗
// ║      transcript: View session transcript slices in the editor      ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║                                                                    ║
// ║  /transcript [target] [N] [full]                                  ║
// ║      N = last N rounds (chatlog/thinking)                         ║
// ║      full = untruncated tool output (chatlog/context)             ║
// ║                                                                    ║
// ║  Rebuilds the requested slice of the current session branch and    ║
// ║  opens it in the configured transcript editor. The configuration   ║
// ║  lives in <agentDir>/mpi-transcript.json and defaults to nvim, vim, ║
// ║  then the in-app multi-line editor when no choice is configured.    ║
// ║  For scrolling and copying; nothing is written to disk.            ║
// ║                                                                    ║
// ║  Targets:                                                          ║
// ║    context       Effective LLM context (what the model sees)       ║
// ║    chatlog       Full transcript (user/assistant/thinking/tools/   ║
// ║                  injected/compaction/branch summaries/errors/      ║
// ║                  cache-miss notices)                               ║
// ║    thinking      All reasoning/thinking blocks                     ║
// ║    latest-agent  Last assistant text reply                         ║
// ║    latest-user   Last user message                                 ║
// ║                                                                    ║
// ║  Data source is the SDK-native session branch                      ║
// ║  (ctx.sessionManager.getBranch()), not any host-internal chat      ║
// ║  model, so the extension is portable across pi hosts.              ║
// ║                                                                    ║
// ╚══════════════════════════════════════════════════════════════════╝

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  BuildSystemPromptOptions,
  CacheMiss,
  ExtensionCommandContext,
  ExtensionFactory,
  ModelPriceSource,
  SessionEntry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  buildSystemPrompt,
  CACHE_TTL_MS,
  collectCacheMisses,
  estimateTokens,
  getAgentDir,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { loadTranscriptConfig, writeTranscriptConfig } from "./config.js";
import { resolveTranscriptEditor, transcriptEditorOptions } from "./editor.js";
import { createTranscriptConfigOverlay } from "./config-overlay.js";
import type { Component, TUI } from "@earendil-works/pi-tui";

// ─── Session content types (subset of SDK AgentMessage we consume) ────────────
//
// We read only the fields we need from getBranch() entries. The SDK's
// AgentMessage is a union; narrowing by `role` and content `type` here keeps
// this extension decoupled from the full type surface.

interface TextBlock {
  type: "text";
  text?: string;
}
interface ThinkingBlock {
  type: "thinking";
  thinking?: string;
  redacted?: boolean;
}
interface ToolCallBlock {
  type: "toolCall";
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string };

// ─── View targets ─────────────────────────────────────────────────────────────

/** Canonical target ids plus the human title rendered above the content. */
const TARGETS = [
  { id: "context", title: "LLM Context", label: "Context (as the LLM sees it)" },
  { id: "chatlog", title: "Chat Export", label: "Chatlog" },
  { id: "thinking", title: "Thinking Export", label: "Thinking" },
  { id: "latest-agent", title: "Latest Agent Reply", label: "Latest agent reply" },
  { id: "latest-user", title: "Latest User Message", label: "Latest user message" },
] as const;

type TargetId = (typeof TARGETS)[number]["id"];

function normalizeTarget(raw: string): TargetId | undefined {
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "chatlog":
      return "chatlog";
    case "context":
      return "context";
    case "thinking":
      return "thinking";
    case "latest-agent":
      return "latest-agent";
    case "latest-user":
      return "latest-user";
    default:
      return undefined;
  }
}

// ─── Transcript statistics ────────────────────────────────────────────────────

interface TranscriptStats {
  totalToolCalls: number;
  toolCalls: ReadonlyMap<string, number>;
  skills: ReadonlyMap<string, number>;
  sessionTurns: number;
  messageCount: number;
  durationMs: number | undefined;
  resultCounts: { success: number; errors: number; pending: number };
}

/** Count assistant tool calls and reads of skill files in a session branch. */
function collectTranscriptStats(entries: SessionEntry[]): TranscriptStats {
  const toolCalls = new Map<string, number>();
  const skills = new Map<string, number>();
  const resultById = new Map<string, boolean>();
  let totalToolCalls = 0;
  let sessionTurns = 0;
  let messageCount = 0;
  let firstAt: number | undefined;
  let lastAt: number | undefined;

  for (const entry of entries) {
    const entryAt = Date.parse(entry.timestamp);
    if (!Number.isNaN(entryAt)) {
      firstAt = firstAt === undefined ? entryAt : Math.min(firstAt, entryAt);
      lastAt = lastAt === undefined ? entryAt : Math.max(lastAt, entryAt);
    }
    if (entry.type !== "message") continue;
    messageCount += 1;
    const message = messageOf(entry);
    if (message?.role === "user" && blockText(message.content).trim()) sessionTurns += 1;
    if (message?.role === "toolResult" && message.toolCallId) {
      resultById.set(message.toolCallId, Boolean(message.isError));
    }
  }

  let success = 0;
  let errors = 0;
  let pending = 0;
  for (const entry of entries) {
    const message = messageOf(entry);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as AssistantBlock[]) {
      if (block.type !== "toolCall") continue;
      const call = block as ToolCallBlock;
      const toolName = call.name ?? "(unknown)";
      toolCalls.set(toolName, (toolCalls.get(toolName) ?? 0) + 1);
      totalToolCalls += 1;

      if (call.id === undefined || !resultById.has(call.id)) pending += 1;
      else if (resultById.get(call.id)) errors += 1;
      else success += 1;

      if (toolName !== "read") continue;
      const rawPath = call.arguments?.file_path ?? call.arguments?.path;
      if (typeof rawPath !== "string" || path.basename(rawPath) !== "SKILL.md") continue;
      const skillName = path.basename(path.dirname(rawPath)) || "SKILL.md";
      skills.set(skillName, (skills.get(skillName) ?? 0) + 1);
    }
  }

  return {
    totalToolCalls,
    toolCalls,
    skills,
    sessionTurns,
    messageCount,
    durationMs: firstAt !== undefined && lastAt !== undefined ? lastAt - firstAt : undefined,
    resultCounts: { success, errors, pending },
  };
}

/**
 * Itemized stats section (Tools/Skills): a header line followed by one
 * `    - name × N` line per item, sorted by count desc then name. An empty
 * section renders `none` on the header line.
 */
function statItemLines(
  label: string,
  summary: string,
  items: ReadonlyMap<string, number>,
): string[] {
  const sorted = [...items.entries()].sort(
    ([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB),
  );
  return [
    `${label} · ${summary}:${sorted.length ? "" : " none"}`,
    ...sorted.map(([name, count]) => `    - \`${name}\` × ${count}`),
  ];
}

/** Rounded box shown before the selected transcript content. */
function renderTranscriptStats(
  stats: TranscriptStats,
  sessionFile: string | null | undefined,
): string {
  // The session file path stays on one line because a mid-path break is
  // unreadable, so it may widen the box; same for an oversized tool name.
  const lines = [
    `Session · ${stats.sessionTurns} turn${stats.sessionTurns === 1 ? "" : "s"} · ${stats.messageCount} message${stats.messageCount === 1 ? "" : "s"} · ${stats.durationMs === undefined ? "duration n/a" : fmtDuration(stats.durationMs)}`,
    `File · ${sessionFile ?? "In-memory"}`,
    `Result · ${stats.resultCounts.success} success · ${stats.resultCounts.errors} errors · ${stats.resultCounts.pending} pending`,
    ...statItemLines("Tools", `${stats.totalToolCalls} total`, stats.toolCalls),
    ...statItemLines(
      "Skills",
      `${[...stats.skills.values()].reduce((total, count) => total + count, 0)} reads`,
      stats.skills,
    ),
  ];
  const title = "📊 Transcript Stats";
  const width = Math.max(title.length, ...lines.map((line) => line.length));
  const row = (text: string) => `│ ${text.padEnd(width)} │`;
  return [
    `╭${"─".repeat(width + 2)}╮`,
    row(title),
    ...lines.map(row),
    `╰${"─".repeat(width + 2)}╯`,
  ].join("\n");
}

// ─── Output assembly ───────────────────────────────────────────────────────

/**
 * Markdown output: `# <title>` followed by blank-line-separated sections.
 * ANSI escape sequences are stripped — session entries may carry terminal-
 * styled text, which renders as raw bytes in an editor — and so is trailing
 * whitespace on every line.
 */
export function formatViewText(title: string, body: string[]): string {
  return [`# ${title}`, ...body]
    .join("\n\n")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[ \t]+$/gm, "");
}

// ─── Content reconstruction from the session branch ───────────────────────────

/** Narrow a branch entry to its message when it is a normal chat message. */
function messageOf(
  entry: SessionEntry,
): { role: string; content: unknown; toolCallId?: string; isError?: boolean } | undefined {
  if (entry.type !== "message") return undefined;
  return entry.message as unknown as { role: string; content: unknown };
}

/**
 * Flatten a message's content (string or block array) to plain text.
 * Image blocks render as a `📷 [image]` placeholder.
 */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type: string; text?: string };
      if (b.type === "image") return "📷 [image]";
      return b.text !== undefined ? b.text : "";
    })
    .filter((text) => text.trim())
    .join("\n");
}

/** Elapsed time as `3.2s` (<10s), `42s` (<60s), or `2m 5s`. */
function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/** Entry timestamp as local `YYYY-MM-DD HH:mm:ss`; raw value if unparsable. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Thinking block text with the redacted placeholder applied. */
function thinkingText(block: ThinkingBlock): string {
  return block.redacted ? "[Reasoning redacted]" : (block.thinking ?? "");
}

/**
 * All thinking blocks across every assistant message, in order. Each block is
 * labeled with its round (1-based count of non-empty user messages so far) so
 * long exports stay navigable; blocks before any user message are unlabeled.
 */
function collectThinking(entries: SessionEntry[], turnOffset = 0): string[] {
  const out: string[] = [];
  let turn = turnOffset;
  for (const entry of entries) {
    const msg = messageOf(entry);
    if (msg?.role === "user" && blockText(msg.content).trim()) turn += 1;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as AssistantBlock[]) {
      if (block.type !== "thinking") continue;
      const text = thinkingText(block as ThinkingBlock);
      const label = turn > 0 ? `**Turn ${turn}**\n\n` : "";
      if (text.trim()) out.push(`---\n\n${label}${text.trim()}`);
    }
  }
  return out;
}

/** Last assistant text reply (thinking/tool-only turns are skipped). */
function latestAgentReply(entries: SessionEntry[]): string | undefined {
  for (const entry of entries.toReversed()) {
    const msg = messageOf(entry);
    if (msg?.role !== "assistant") continue;
    const text = blockText(msg.content);
    if (text.trim()) return text;
  }
  return undefined;
}

/** Last user message text. */
function latestUserMessage(entries: SessionEntry[]): string | undefined {
  for (const entry of entries.toReversed()) {
    const msg = messageOf(entry);
    if (msg?.role !== "user") continue;
    const text = blockText(msg.content);
    if (text.trim()) return text;
  }
  return undefined;
}

/** Tool result output is capped at this many lines; the rest is summarized. */
const TOOL_RESULT_MAX_LINES = 20;

/** Shortest backtick fence that safely wraps `text` (which may contain fences). */
function fenceFor(text: string): string {
  const runs = text.match(/`{3,}/g);
  return "`".repeat(runs ? Math.max(3, ...runs.map((r) => r.length)) + 1 : 3);
}

// ─── Skill reads: a successful read of SKILL.md renders as a skill card ─────

interface SkillReadInfo {
  name: string;
  description: string;
  /** Content after the closing frontmatter fence, trimmed. */
  body: string;
  /** Path argument exactly as passed to the read tool. */
  path: string;
}

/** Strip one pair of matching surrounding quotes, if present. */
function unquote(value: string): string {
  const q = value[0];
  return (q === '"' || q === "'") && value.endsWith(q) && value.length >= 2
    ? value.slice(1, -1)
    : value;
}

/**
 * Recognize a successful `read` of a `SKILL.md` whose result opens with a
 * `---` frontmatter block, and parse it into card fields. For anything else,
 * including other tools, other paths, error or missing results, and
 * unterminated frontmatter, returns undefined so the caller keeps the
 * generic tool rendering.
 */
function skillReadInfo(
  call: ToolCallBlock,
  result: { status: string; text: string } | undefined,
): SkillReadInfo | undefined {
  if (call.name !== "read" || !result || result.status === "error") return undefined;
  const rawPath = call.arguments?.file_path ?? call.arguments?.path;
  if (typeof rawPath !== "string" || path.basename(rawPath) !== "SKILL.md") return undefined;
  const lines = result.text.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  // Line-oriented frontmatter parse: `name:`/`description:` values, with
  // indented continuation lines folded into one space-joined value.
  let name = "";
  let description = "";
  let key: "name" | "description" | undefined;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") {
      close = i;
      break;
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      key = m[1] === "name" || m[1] === "description" ? m[1] : undefined;
      const value = m[2]!.trim();
      if (key === "name") name = value;
      else if (key === "description") description = value;
    } else if (key && /^\s+\S/.test(line)) {
      const value = ` ${line.trim()}`;
      if (key === "name") name += value;
      else description += value;
    }
  }
  if (close < 0) return undefined;
  const dir = path.basename(path.dirname(rawPath));
  return {
    name: unquote(name) || (dir && dir !== "." ? dir : "SKILL.md"),
    description: unquote(description),
    body: lines
      .slice(close + 1)
      .join("\n")
      .trim(),
    path: rawPath,
  };
}

/**
 * Skill card section: name heading, path line, description paragraph, and
 * the frontmatter-stripped body rendered as markdown. The body keeps the
 * generic head-side tool-output cap; `fullToolOutput` uncaps it.
 */
function renderSkillCard(skill: SkillReadInfo, fullToolOutput: boolean | undefined): string {
  const description = skill.description ? `${skill.description}\n\n` : "";
  let body = "";
  if (skill.body) {
    const lines = skill.body.split("\n");
    const cap = fullToolOutput ? Infinity : TOOL_RESULT_MAX_LINES;
    const kept = lines.slice(0, cap).join("\n");
    const more = lines.length - cap;
    body = more > 0 ? `${kept}\n\n_… +${more} more lines_` : kept;
  }
  return `### 📘 Skill: ${skill.name} — ✅ success\n\n_${skill.path}_\n\n${description}${body}`;
}

// Full transcript as markdown sections: numbered user/assistant rounds,
// injected context, compaction/branch summaries, tool calls (paired to their
// results by toolCallId), thinking quotes, and error/abort markers.
/** Tokens as a compact k-suffixed figure: 8432 → "8.4k", 200000 → "200k". */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/**
 * Ten-cell bar for a context share, readable without parsing the percentage
 * beside it. Clamped at both ends. A turn kept across a compaction boundary
 * can report more tokens than the window holds.
 */
function contextBar(share: number): string {
  const cells = 10;
  const filled = Math.max(0, Math.min(cells, Math.round(share * cells)));
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

/** Resolves a model's context window in tokens; undefined when unknown. */
type ContextWindowLookup = (provider: string, modelId: string) => number | undefined;

/** Model attributes the transcript reads: context window and cache-read price. */
interface TranscriptModel {
  contextWindow: number;
  cost: { cacheRead: number };
}

/** Registry surface the transcript needs: exact lookup plus a full listing. */
export interface TranscriptModelRegistry {
  find(provider: string, modelId: string): TranscriptModel | undefined;
  getAll(): readonly (TranscriptModel & { provider: string; id: string })[];
}

/**
 * Model lookup for archived assistant messages, which record the id the
 * provider echoed in its response (`output.model = event.message.model` in
 * pi-ai), not the configured `model.id`. Proxies commonly echo a different
 * case, so an exact miss retries case-insensitively before giving up; without
 * it the turn loses its context bar and cache pricing.
 */
export function resolveModel(
  registry: TranscriptModelRegistry,
  provider: string,
  modelId: string,
): TranscriptModel | undefined {
  const exact = registry.find(provider, modelId);
  if (exact) return exact;
  const lower = modelId.toLowerCase();
  return registry.getAll().find((m) => m.provider === provider && m.id.toLowerCase() === lower);
}

/**
 * Upstream `estimateTextTokens` (chars/4). Reimplemented because pi-ai keeps it
 * behind `./utils/estimate`, which its package `exports` map does not expose.
 */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Prompt-side context that precedes the messages on every request. */
export interface ContextPrefix {
  /** Fully assembled system prompt, as sent to the model. */
  systemPrompt: string;
  /** Tool definitions serialized into the request, already filtered to active tools. */
  tools: ToolInfo[];
}

export interface ContextSizeEstimate {
  total: number;
  systemPrompt: number;
  tools: number;
  messages: number;
  messageCount: number;
}

/**
 * Estimated size of the effective LLM context: system prompt + tool schemas +
 * every message the entries expand to.
 *
 * Deliberately never seeded from assistant `usage`. Messages kept across a
 * compaction boundary still carry their pre-compaction usage, which reports the
 * old (larger) context and would inflate the total — the same trap upstream
 * guards against in `AgentSession.getContextUsage`. Pure chars/4 throughout, so
 * the result is an estimate and must be labeled as one.
 */
export function estimateContextSize(
  entries: SessionEntry[],
  prefix: ContextPrefix,
): ContextSizeEstimate {
  // Upstream expansion: compaction and branch_summary entries become summary
  // messages here, so their text is counted instead of silently dropped.
  const messages = entries.flatMap(sessionEntryToContextMessages);
  let messageTokens = 0;
  for (const message of messages) messageTokens += estimateTokens(message);
  const systemPromptTokens = estimateTextTokens(prefix.systemPrompt);
  const toolTokens = prefix.tools.length ? estimateTextTokens(JSON.stringify(prefix.tools)) : 0;
  return {
    total: systemPromptTokens + toolTokens + messageTokens,
    systemPrompt: systemPromptTokens,
    tools: toolTokens,
    messages: messageTokens,
    messageCount: messages.length,
  };
}

/**
 * Summary line for the context view. Always reflects the whole effective
 * context, never the `lastTurns` display slice — the model sees all of it.
 */
function contextSizeLine(estimate: ContextSizeEstimate, contextWindow: number | undefined): string {
  const share = contextWindow
    ? `~${fmtTokens(estimate.total)}/${fmtTokens(contextWindow)} ${contextBar(estimate.total / contextWindow)} (${((estimate.total / contextWindow) * 100).toFixed(1)}%)`
    : `~${fmtTokens(estimate.total)}`;
  const parts = [
    `${fmtTokens(estimate.systemPrompt)} system`,
    `${fmtTokens(estimate.tools)} tools`,
    `${fmtTokens(estimate.messages)} across ${estimate.messageCount} message${estimate.messageCount === 1 ? "" : "s"}`,
  ];
  return `_${share} estimated — ${parts.join(" + ")}_`;
}

/** Context window of the model that produced the latest assistant reply. */
function currentContextWindow(
  entries: SessionEntry[],
  contextWindowFor: ContextWindowLookup | undefined,
): number | undefined {
  if (!contextWindowFor) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message as AssistantMessage;
    if (message.role !== "assistant" || !message.provider || !message.model) continue;
    return contextWindowFor(message.provider, message.model);
  }
  return undefined;
}

/**
 * One-line warning for a counted cache miss, or undefined when it is noise:
 * below 20k missed tokens and $0.10 excess cost nothing is shown. The label
 * attributes the miss to a model switch or a cache-TTL idle gap when it can.
 */
function cacheMissNotice(miss: CacheMiss): string | undefined {
  if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return undefined;
  const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
  let label = "Cache miss";
  if (miss.modelChanged) label = "Cache miss after model switch";
  else if (miss.idleMs >= CACHE_TTL_MS)
    label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
  return `${label}: ${fmtTokens(miss.missedTokens)} tokens re-billed${cost}`;
}

interface ChatlogOptions {
  turnOffset?: number;
  contextWindowFor?: ContextWindowLookup;
  cacheMisses?: Map<AssistantMessage, CacheMiss>;
  /** Render complete tool results instead of the 20-line cap. */
  fullToolOutput?: boolean;
}

function collectChatlog(entries: SessionEntry[], options: ChatlogOptions = {}): string[] {
  const { turnOffset = 0, contextWindowFor, cacheMisses, fullToolOutput } = options;
  const resultById = new Map<string, { status: string; text: string }>();
  for (const entry of entries) {
    const msg = messageOf(entry) as
      | {
          role: string;
          toolCallId?: string;
          toolName?: string;
          content?: unknown;
          isError?: boolean;
        }
      | undefined;
    if (msg?.role === "toolResult" && msg.toolCallId) {
      resultById.set(msg.toolCallId, {
        status: msg.isError ? "error" : "success",
        text: blockText(msg.content),
      });
    }
  }

  const sections: string[] = [];
  // Round counter: each non-empty user message starts a new round; assistant
  // sections carry the round of the user message they answer.
  let turn = turnOffset;
  // Previous assistant turn's context size, for the context-growth delta.
  let prevContext: number | undefined;
  // Previous message entry's epoch ms, for the assistant elapsed-time display.
  let prevMsgAt: number | undefined;
  for (const entry of entries) {
    // One-line timeline events: model / thinking level switches explain why
    // the conversation's behavior changed mid-session.
    if (entry.type === "model_change") {
      sections.push(`---\n\n_🔄 model → ${entry.provider}/${entry.modelId}_`);
      continue;
    }
    if (entry.type === "thinking_level_change") {
      sections.push(`---\n\n_🔄 thinking → ${entry.thinkingLevel}_`);
      continue;
    }
    // Compaction replaces all prior context with its summary; branch summaries
    // stand in for another branch. Both are LLM-visible, so the chatlog must
    // show them or the transcript reads as if context appeared from nowhere.
    if (entry.type === "compaction") {
      const tokens = entry.tokensBefore.toLocaleString("en-US");
      sections.push(`---\n\n## 📦 Compaction · ${tokens} tokens before\n\n${entry.summary.trim()}`);
      continue;
    }
    if (entry.type === "branch_summary") {
      sections.push(`---\n\n## 🌿 Branch Summary\n\n${entry.summary.trim()}`);
      continue;
    }
    // Extension-injected context messages. They join LLM context as user
    // messages but are not real user turns, so they do not advance the round
    // counter. display:false means hidden in the TUI — surfaced here with a
    // marker since this view exists to reveal them.
    if (entry.type === "custom_message") {
      const text = blockText(entry.content);
      const hidden = entry.display ? "" : " · _hidden_";
      if (text.trim())
        sections.push(`---\n\n## 📥 Injected · \`${entry.customType}\`${hidden}\n\n${text.trim()}`);
      continue;
    }
    const msg = messageOf(entry) as
      | {
          role: string;
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
          provider?: string;
          model?: string;
          usage?: {
            totalTokens?: number;
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            cost?: { total?: number };
          };
        }
      | undefined;
    if (!msg) continue;
    const entryAt = Date.parse(entry.timestamp);
    if (msg.role === "user") {
      const text = blockText(msg.content);
      if (text.trim()) {
        turn += 1;
        sections.push(
          `---\n\n## 👤 User · #${turn}\n\n_${formatTime(entry.timestamp)}_\n\n${text.trim()}`,
        );
      }
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content as AssistantBlock[]) {
        if (block.type === "text") {
          const text = (block as TextBlock).text ?? "";
          if (text.trim()) parts.push(text.trim());
        } else if (block.type === "thinking") {
          const text = thinkingText(block as ThinkingBlock);
          // Render thinking as a labeled blockquote
          if (text.trim())
            parts.push(`> **💭 Thinking**\n>\n> ${text.trim().replace(/\n/g, "\n> ")}`);
        } else if (block.type === "toolCall") {
          const call = block as ToolCallBlock;
          const result = call.id ? resultById.get(call.id) : undefined;
          // A successful SKILL.md read renders as a skill card instead of the
          // generic raw-file block; everything else falls through unchanged.
          const skill = skillReadInfo(call, result);
          if (skill) {
            parts.push(renderSkillCard(skill, fullToolOutput));
          } else {
            const name = call.name ?? "(unknown)";
            // No paired result means the call never completed (e.g. aborted).
            const status = result
              ? result.status === "error"
                ? "❌ error"
                : "✅ success"
              : "⏳ no result";
            // Tool call arguments as a fenced JSON block; empty/missing args render nothing.
            const args =
              call.arguments && Object.keys(call.arguments).length ? call.arguments : undefined;
            let argsBlock = "";
            if (args) {
              const json = JSON.stringify(args, null, 2);
              const f = fenceFor(json);
              argsBlock = `\n\n${f}json\n${json}\n${f}`;
            }
            // Tool output in a fence sized past any fence inside it, truncated so
            // one big read/bash result cannot drown the transcript. Successful
            // output keeps the head; failed output keeps the tail, where stack
            // traces and error summaries usually live.
            const resultText = result?.text.trim() ?? "";
            let body = "";
            if (resultText) {
              const lines = resultText.split("\n");
              const isError = result?.status === "error";
              // Infinity cap keeps every line and yields a negative `more`,
              // which the notice branches below treat as "nothing hidden".
              const cap = fullToolOutput ? Infinity : TOOL_RESULT_MAX_LINES;
              const kept = (isError ? lines.slice(-cap) : lines.slice(0, cap)).join("\n");
              const f = fenceFor(kept);
              const more = lines.length - cap;
              const block = `${f}\n${kept}\n${f}`;
              if (more <= 0) body = `\n\n${block}`;
              else if (isError) body = `\n\n_… +${more} earlier lines_\n\n${block}`;
              else body = `\n\n${block}\n\n_… +${more} more lines_`;
            }
            parts.push(`### 🔧 Tool: ${name} — ${status}${argsBlock}${body}`);
          }
        }
      }
      // Surface failed/interrupted turns; without this an errored turn with no
      // text would vanish from the transcript.
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        const em = msg.errorMessage ?? "";
        // Multi-line messages (API error bodies, stack traces) would break the
        // inline bold marker; give them a fenced block instead.
        if (em.includes("\n")) {
          const f = fenceFor(em);
          parts.push(`**❗ ${msg.stopReason}**\n\n${f}\n${em}\n${f}`);
        } else {
          parts.push(`**❗ ${msg.stopReason}**${em ? `: ${em}` : ""}`);
        }
      }
      // messageOf returns the entry's message by reference, so the miss map
      // (keyed by assistant message identity) resolves directly.
      const miss = cacheMisses?.get(msg as unknown as AssistantMessage);
      const notice = miss ? cacheMissNotice(miss) : undefined;
      if (notice) parts.push(`**❗ ${notice}**`);
      if (parts.length) {
        // Meta line: model, token/cost totals (omitted when zero), timestamp.
        const meta: string[] = [];
        if (msg.model) meta.push(msg.provider ? `${msg.provider}/${msg.model}` : msg.model);
        {
          const num = (n: number) => n.toLocaleString("en-US");
          const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = msg.usage ?? {};
          // Context size follows the host's calculateContextTokens semantics.
          // Its per-turn delta tracks context growth; negative after compaction,
          // which is exactly the signal worth spotting.
          const ctxTokens = msg.usage?.totalTokens || input + output + cacheRead + cacheWrite;
          if (ctxTokens > 0) {
            const delta = prevContext !== undefined ? ctxTokens - prevContext : 0;
            const deltaPart = delta !== 0 ? `${delta > 0 ? "+" : "-"}${num(Math.abs(delta))}` : "";
            const cw =
              msg.provider && msg.model ? contextWindowFor?.(msg.provider, msg.model) : undefined;
            if (cw) {
              const inner = [`${((ctxTokens / cw) * 100).toFixed(1)}%`, deltaPart]
                .filter(Boolean)
                .join(", ");
              meta.push(
                `${fmtTokens(ctxTokens)}/${fmtTokens(cw)} ${contextBar(ctxTokens / cw)} (${inner})`,
              );
            } else {
              meta.push(`${num(ctxTokens)} tok${deltaPart ? ` (${deltaPart})` : ""}`);
            }
            prevContext = ctxTokens;
          }
          // in = newly billed uncached input, out = completion — matching the
          // usage-normalized semantics (usage.input excludes cache read/write).
          if (input > 0 || output > 0) {
            meta.push(`in ${num(input)}`, `out ${num(output)}`);
          }
          // Cache hit rate = cacheRead / all prompt tokens; shown only when the
          // request touched the cache at all (read or write).
          const prompt = input + cacheRead + cacheWrite;
          if (prompt > 0 && cacheRead + cacheWrite > 0) {
            meta.push(`cache ${((cacheRead / prompt) * 100).toFixed(1)}%`);
          }
        }
        if (msg.usage?.cost?.total) meta.push(`$${msg.usage.cost.total.toFixed(4)}`);
        // Elapsed since the previous message (usually the user prompt or the
        // prior tool-loop step); skipped when clocks are missing or go backwards.
        if (prevMsgAt !== undefined && !Number.isNaN(entryAt) && entryAt > prevMsgAt) {
          meta.push(fmtDuration(entryAt - prevMsgAt));
        }
        meta.push(formatTime(entry.timestamp));
        sections.push(
          `---\n\n## 🤖 Assistant${turn > 0 ? ` · #${turn}` : ""}\n\n_${meta.join(" · ")}_\n\n${parts.join("\n\n")}`,
        );
      }
    }
    // Every message entry (any role) advances the elapsed-time reference.
    if (!Number.isNaN(entryAt)) prevMsgAt = entryAt;
  }
  return sections;
}

// Cut the branch down to its last N rounds (a round starts at a non-empty
// user message). Returns the retained tail plus the number of omitted rounds,
// so turn numbering stays global across the cut.
function cutForLastTurns(
  entries: SessionEntry[],
  lastTurns: number | undefined,
): { sliced: SessionEntry[]; turnOffset: number } {
  if (!lastTurns) return { sliced: entries, turnOffset: 0 };
  const starts: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const msg = messageOf(entries[i]!);
    if (msg?.role === "user" && blockText(msg.content).trim()) starts.push(i);
  }
  if (starts.length <= lastTurns) return { sliced: entries, turnOffset: 0 };
  const omitted = starts.length - lastTurns;
  return { sliced: entries.slice(starts[omitted]!), turnOffset: omitted };
}

export interface BuildViewOptions {
  /**
   * Restrict chatlog/thinking/context to the last N rounds; omitted rounds
   * are announced in a leading notice line.
   */
  lastTurns?: number;
  /** Enables per-turn context-usage percentages next to token counts. */
  contextWindowFor?: ContextWindowLookup;
  /** Enables cache-miss notices in chatlog/context when provided. */
  priceSource?: ModelPriceSource;
  /** Render complete tool results instead of the 20-line cap. */
  fullToolOutput?: boolean;
  /** Absolute session JSONL path; null when the session is not persisted. */
  sessionFile?: string | null;
  /**
   * Prompt-side context for the `context` view's size estimate. Omitted for
   * other targets and when the caller cannot resolve it; the summary line is
   * then left out rather than estimated from messages alone.
   */
  contextPrefix?: ContextPrefix;
}

/** Build the final editor text for a target from the session branch. */
export function buildViewText(
  target: TargetId,
  entries: SessionEntry[],
  options: BuildViewOptions = {},
): string {
  const { lastTurns, contextWindowFor, priceSource, fullToolOutput, contextPrefix, sessionFile } =
    options;
  const meta = TARGETS.find((t) => t.id === target)!;
  const stats = renderTranscriptStats(collectTranscriptStats(entries), sessionFile);
  if (target === "thinking" || target === "chatlog" || target === "context") {
    const { sliced, turnOffset } = cutForLastTurns(entries, lastTurns);
    const note =
      turnOffset > 0
        ? [`_… earlier ${turnOffset} turn${turnOffset === 1 ? "" : "s"} omitted_`]
        : [];
    if (target === "thinking") {
      const thinking = collectThinking(sliced, turnOffset);
      return formatViewText(meta.title, [
        stats,
        ...note,
        ...(thinking.length ? thinking : ["No thinking entries."]),
      ]);
    }
    // chatlog and context share the section renderer; they differ only in
    // which entry set the caller feeds in (full branch vs effective context).
    // Misses are computed on the unsliced entries so the first assistant
    // message in a lastTurns cut still sees its previous request.
    const cacheMisses = priceSource ? collectCacheMisses(entries, priceSource) : undefined;
    // Sized from the unsliced entries: a lastTurns cut hides rounds from the
    // reader, not from the model.
    const sizeLine =
      target === "context" && contextPrefix
        ? [
            contextSizeLine(
              estimateContextSize(entries, contextPrefix),
              currentContextWindow(entries, contextWindowFor),
            ),
          ]
        : [];
    return formatViewText(meta.title, [
      stats,
      ...sizeLine,
      ...note,
      ...collectChatlog(sliced, { turnOffset, contextWindowFor, cacheMisses, fullToolOutput }),
    ]);
  }
  if (target === "latest-agent") {
    return formatViewText(meta.title, [
      stats,
      latestAgentReply(entries) ?? "No assistant message.",
    ]);
  }
  return formatViewText(meta.title, [stats, latestUserMessage(entries) ?? "No user message."]);
}

// ─── Display: configured external editor with in-app editor fallback ─────────

type ExternalEditorResult = { ok: true } | { ok: false; error: string };

function transcriptConfigError(loaded: { ok: false; path: string; error: string }): string {
  return `mpi-transcript config error (${loaded.path}): ${loaded.error}`;
}

/**
 * Extra CLI flags for vim/nvim (matched on the binary's basename). `--clean`
 * skips the user's init, plugins, and colorscheme; plugins cost seconds on
 * multi-MB transcript buffers (measured 6s to 0.4s on a 178k-line export),
 * and the view ships its own styling. `-R` makes the buffer readonly, `-n`
 * disables swap, `+normal G` jumps to the end where the latest content
 * lives. nvim sources `luafile` and vim sources the view script when a path
 * is given. Other editors get none.
 */
export function editorExtraArgs(cmd: string, scriptFile?: string): string[] {
  const base = path.basename(cmd);
  if (base !== "nvim" && base !== "vim") return [];
  // --clean implies -u NONE / --noplugin / no shada, so no separate -i NONE.
  const args = ["--clean", "-R", "-n", "+normal G"];
  if (!scriptFile) return args;
  if (base === "nvim") args.push("-c", `luafile ${scriptFile}`);
  else args.push("-c", `source ${scriptFile}`);
  return args;
}

/** Sourced into nvim after the transcript buffer loads (`-c luafile`). */
export const NVIM_TRANSCRIPT_LUA = `
-- Legacy markdown syntax, not treesitter. The treesitter parser walks the
-- whole buffer up front (seconds on multi-MB transcripts), while legacy
-- syntax highlights only the visible window at redraw. filetype is already
-- "markdown" under --clean, so enabling syntax is all this needs.
vim.cmd("syntax enable")
-- The default colorscheme leaves legacy markdown code spans and fenced
-- blocks uncolored. Special is the same color treesitter gives them.
vim.api.nvim_set_hl(0, "markdownCodeDelimiter", { link = "Special" })
vim.api.nvim_set_hl(0, "markdownCode", { link = "Special" })
vim.api.nvim_set_hl(0, "markdownCodeBlock", { link = "Special" })

vim.opt_local.conceallevel = 2
-- Overlay virt_text replaces headings and metadata. Without this the raw
-- markup pops back in whenever the cursor lands on such a line, and the whole
-- view jitters while scrolling.
vim.opt_local.concealcursor = "nvic"
vim.opt_local.wrap = true
vim.opt_local.linebreak = true
vim.opt_local.signcolumn = "no"
vim.opt_local.foldmethod = "manual"
vim.opt_local.foldenable = true
vim.opt_local.fillchars:append({ fold = " " })

-- Every color the view uses is a named group linked to a group that always
-- exists (no treesitter dependency), declared with default = true so a user
-- colorscheme defining MpiTranscript* wins.
local ROLES = {
  MpiTranscriptUser = "Title",
  MpiTranscriptAssistant = "Identifier",
  MpiTranscriptTool = "Statement",
  MpiTranscriptSkill = "Question",
  MpiTranscriptInjected = "Special",
  MpiTranscriptCompaction = "WarningMsg",
  MpiTranscriptBranch = "Type",
  MpiTranscriptError = "ErrorMsg",
}
local CHROME = { MpiTranscriptTurn = "Identifier", MpiTranscriptRule = "NonText" }
for _, group in ipairs({ ROLES, CHROME }) do
  for name, link in pairs(group) do
    vim.api.nvim_set_hl(0, name, { default = true, link = link })
  end
end

-- Badge chips reuse the role color as a background. reverse swaps fg/bg at
-- render time, so this stays correct on a transparent Normal background where
-- reading Normal.bg would yield nil.
for name in pairs(ROLES) do
  local resolved = vim.api.nvim_get_hl(0, { name = name, link = false })
  vim.api.nvim_set_hl(0, name .. "Badge", { fg = resolved.fg, reverse = true, bold = true })
end

local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
local tick3 = string.rep(string.char(96), 3)

local function role_heading(line)
  if line:match([[^## 👤 User]]) then return "user" end
  if line:match([[^## 🤖 Assistant]]) then return "assistant" end
  if line:match([[^## 📥 Injected]]) then return "injected" end
  if line:match([[^## 📦 Compaction]]) then return "compaction" end
  if line:match([[^## 🌿 Branch Summary]]) then return "branch" end
  return nil
end

local function tool_heading(line)
  return line:match([[^### 🔧 Tool]]) ~= nil
end

local function fence_open(line)
  return line:match("^(" .. tick3 .. "+)")
end

function _G.MpiTranscriptFoldtext()
  local s, e = vim.v.foldstart, vim.v.foldend
  local name = "tool"
  for k = s, 1, -1 do
    local line = vim.fn.getline(k)
    if tool_heading(line) then
      local raw = line:match("Tool:%s*(.-)%s*—") or line:match("Tool:%s*(.+)$") or ""
      -- Headings carry bare tool names, so only trim spaces.
      name = raw:gsub("^%s+", ""):gsub("%s+$", "")
      if name == "" then name = "tool" end
      break
    end
  end
  local open = vim.fn.getline(math.max(1, s - 1))
  local lang = open:match(tick3 .. "+(%w*)") or ""
  local io = lang == "json" and "in" or "out"
  return "  ▸ " .. name .. " " .. io .. " · " .. (e - s + 1) .. " lines"
end
vim.opt_local.foldtext = "v:lua.MpiTranscriptFoldtext()"

-- A '---' separator becomes a full-width rule, and every role heading becomes
-- a colored badge chip followed by its remainder. Both draw as overlay
-- virt_text over concealed markup, so no '##' or em-dash reaches the screen
-- while the document itself stays valid markdown.

-- The heading suffix after a fixed prefix, with the ' · ' joiner dropped. The
-- joiner cannot be an optional pattern item. '·' is two bytes, and a Lua '?'
-- would make only its second byte optional, which fails on a turn-0
-- '## 🤖 Assistant' that carries no joiner.
local function suffix_after(line, prefix)
  local rest = line:match("^" .. prefix .. "(.*)$")
  if not rest then return nil end
  return (rest:gsub("^%s*·%s*", ""))
end

local function heading_badge(line)
  local rest = suffix_after(line, "## 👤 User")
  if rest then return " 👤 USER ", rest, "MpiTranscriptUser" end
  rest = suffix_after(line, "## 🤖 Assistant")
  if rest then return " 🤖 AGENT ", rest, "MpiTranscriptAssistant" end
  local name, status = line:match("^### 🔧 Tool:%s*(.-)%s*—%s*(.+)$")
  if name then
    -- A failed call takes the error color so the chip reads as red at a
    -- glance. Its status text stays in the suffix for readers who cannot
    -- rely on color.
    local role = line:match("❌") and "MpiTranscriptError" or "MpiTranscriptTool"
    return " 🔧 " .. name .. " ", status, role
  end
  name, status = line:match("^### 📘 Skill:%s*(.-)%s*—%s*(.+)$")
  if name then return " 📘 " .. name .. " ", status, "MpiTranscriptSkill" end
  rest = suffix_after(line, "## 📥 Injected")
  if rest then return " 📥 INJECTED ", rest, "MpiTranscriptInjected" end
  rest = suffix_after(line, "## 📦 Compaction")
  if rest then return " 📦 COMPACTION ", rest, "MpiTranscriptCompaction" end
  rest = suffix_after(line, "## 🌿 Branch Summary")
  if rest then return " 🌿 BRANCH ", rest, "MpiTranscriptBranch" end
  return nil
end

local deco_ns = vim.api.nvim_create_namespace("mpi_transcript_deco")
local rule = string.rep("─", vim.o.columns)
-- Verbatim tool output must reach the screen exactly as captured, so nothing
-- inside a tool fence is decorated or counted as a turn. The scan covers only
-- the fences directly under a Tool heading. This extension emits those itself
-- with a delimiter longer than any run inside them, so they always close.
-- Model prose carries no such guarantee, and one unclosed fence in a truncated
-- reply would leave every later heading and separator undecorated. Stop at the
-- first non-blank, non-fence line so prose following a tool call is untouched.
local tool_fences = {}
local in_fence = {}
local scan = 1
while scan <= #lines do
  if not tool_heading(lines[scan]) then
    scan = scan + 1
  else
    scan = scan + 1
    while scan <= #lines do
      if lines[scan]:match("^%s*$") then
        scan = scan + 1
      else
        local ticks = fence_open(lines[scan])
        if not ticks then break end
        local close = scan + 1
        while close <= #lines and not lines[close]:match("^" .. ticks) do
          close = close + 1
        end
        for k = scan, math.min(close, #lines) do in_fence[k] = true end
        tool_fences[#tool_fences + 1] = { open = scan, close = close }
        scan = math.min(close, #lines) + 1
      end
    end
  end
end

for i, line in ipairs(lines) do
  if not in_fence[i] then
    if line == "---" then
      vim.api.nvim_buf_set_extmark(0, deco_ns, i - 1, 0, {
        virt_text = { { rule, "MpiTranscriptRule" } },
        virt_text_pos = "overlay",
        virt_text_win_col = 0,
        priority = 200,
      })
    else
      local badge, rest, role = heading_badge(line)
      if badge then
        local chunks = { { badge, role .. "Badge" } }
        if rest ~= "" then chunks[#chunks + 1] = { "  " .. rest, role } end
        vim.api.nvim_buf_set_extmark(0, deco_ns, i - 1, 0, {
          end_col = #line,
          conceal = "",
          virt_text = chunks,
          virt_text_pos = "overlay",
          virt_text_win_col = 0,
          priority = 200,
        })
      end
    end
  end
end

local dim_ns = vim.api.nvim_create_namespace("mpi_transcript_dim")
local t = 1
while t <= #lines do
  local line = lines[t]
  local dim = line:match("^_🔄") or line:match("^_%d%d%d%d%-") or line:match("^_.+ · %d%d%d%d%-")
  if dim then
    vim.api.nvim_buf_set_extmark(0, dim_ns, t - 1, 0, { line_hl_group = "Comment" })
    if line:sub(1, 1) == "_" and line:sub(-1) == "_" and #line >= 2 then
      vim.api.nvim_buf_set_extmark(0, dim_ns, t - 1, 0, { end_col = 1, conceal = "" })
      vim.api.nvim_buf_set_extmark(0, dim_ns, t - 1, #line - 1, { end_col = #line, conceal = "" })
    end
    t = t + 1
  elseif line:match("^>") and line:match("💭 Thinking") then
    while t <= #lines and lines[t]:match("^>") do
      vim.api.nvim_buf_set_extmark(0, dim_ns, t - 1, 0, { line_hl_group = "Comment" })
      t = t + 1
    end
  else
    t = t + 1
  end
end

-- Fold each tool fence's body, reusing the spans found above. An unterminated
-- fence (close past the last line) has no body to collapse.
for _, f in ipairs(tool_fences) do
  if f.close <= #lines and f.close - f.open > 1 then
    vim.cmd(("silent %d,%dfold"):format(f.open + 1, f.close - 1))
  end
end

-- turns drives ]t/[t and the winbar label. users is the ]u/[u subset, holding
-- only the reader's own messages.
local turns = {}
local users = {}
for n, line in ipairs(lines) do
  local kind = not in_fence[n] and role_heading(line) or nil
  if kind == "user" or kind == "assistant" then
    local turn = { lnum = n, text = line }
    turns[#turns + 1] = turn
    if kind == "user" then users[#users + 1] = turn end
  end
end

local function turn_at(lnum)
  local s, e, info = 1, #lines, nil
  for i, t in ipairs(turns) do
    if t.lnum <= lnum then
      info = t
      s = t.lnum
      e = turns[i + 1] and (turns[i + 1].lnum - 1) or #lines
    else
      break
    end
  end
  return s, e, info
end

local function heading_label(info)
  if not info then return "" end
  local h = info.text:gsub("^#+%s+", "")
  local below = lines[info.lnum + 1] or ""
  if below == "" then below = lines[info.lnum + 2] or "" end
  local dur = below:match([[· ([%d%.]+s) · %d%d%d%d%-]]) or below:match([[· (%d+m %d+s) · %d%d%d%d%-]])
  if dur then h = h .. " · " .. dur end
  return h
end

_G.MpiTranscriptTurn = { s = 1, e = 1 }
-- Wrapped continuation rows (v:virtnum > 0) re-evaluate 'statuscolumn'; the
-- native %s and %l items render with different widths there, which shifts the
-- turn bar. Build the whole column (bar, number) in one function that emits
-- identical-width content for every screen row of a line.
function _G.MpiTranscriptStc()
  local t = _G.MpiTranscriptTurn
  local l = vim.v.lnum
  local bar = (t and l > t.s and l <= t.e) and "│" or " "
  local virt = vim.v.virtnum > 0
  local num = virt and string.rep(" ", #tostring(l)) or tostring(l)
  return "%#MpiTranscriptTurn#" .. bar .. "%#LineNr#" .. num .. " "
end
vim.opt_local.statuscolumn = "%!v:lua.MpiTranscriptStc()"

local function refresh()
  local s, e, info = turn_at(vim.api.nvim_win_get_cursor(0)[1])
  _G.MpiTranscriptTurn.s = s
  _G.MpiTranscriptTurn.e = e
  local h = heading_label(info)
  local keys = "%=[t/]t turn  [u/]u user"
  vim.wo.winbar = h == "" and keys or (" " .. h:gsub("%%", "%%%%") .. keys)
end

-- Cursor stays put when there is no heading left in that direction, matching
-- how ]] and [[ behave at the ends of a buffer.
local function jump_to(list, dir)
  local lnum = vim.api.nvim_win_get_cursor(0)[1]
  if dir > 0 then
    for _, t in ipairs(list) do
      if t.lnum > lnum then
        vim.api.nvim_win_set_cursor(0, { t.lnum, 0 })
        return
      end
    end
  else
    for i = #list, 1, -1 do
      if list[i].lnum < lnum then
        vim.api.nvim_win_set_cursor(0, { list[i].lnum, 0 })
        return
      end
    end
  end
end
local function map_jump(lhs, list, dir)
  vim.keymap.set("n", lhs, function() jump_to(list, dir) end, { buffer = true, silent = true })
end
map_jump("]t", turns, 1)
map_jump("[t", turns, -1)
map_jump("]u", users, 1)
map_jump("[u", users, -1)

vim.api.nvim_create_autocmd("CursorMoved", {
  buffer = 0,
  callback = refresh,
})
refresh()
`;

/** Sourced into vim after the transcript buffer loads (`-c source`). */
export const VIM_TRANSCRIPT_VIM = `
" mpi-transcript vim view. Sourced after the buffer loads (-c source).
set encoding=utf-8
scriptencoding utf-8
if !has('conceal') || !has('eval') || !has('folding')
  echoerr 'mpi-transcript: vim view requires +conceal, +eval, and +folding'
  finish
endif

" View options after syntax enable: markdown ftplugin would otherwise change
" foldmethod and conceallevel.
syntax enable
setlocal conceallevel=2
setlocal concealcursor=nvic
setlocal wrap
setlocal linebreak
setlocal signcolumn=no
setlocal foldmethod=manual
setlocal foldenable
let s:fc = []
for s:item in split(&fillchars, ',')
  if s:item !~# '^fold:'
    call add(s:fc, s:item)
  endif
endfor
call add(s:fc, 'fold:' . nr2char(32))
let &l:fillchars = join(s:fc, ',')

hi default link MpiTranscriptUser Title
hi default link MpiTranscriptAssistant Identifier
hi default link MpiTranscriptTool Statement
hi default link MpiTranscriptSkill Question
hi default link MpiTranscriptInjected Special
hi default link MpiTranscriptCompaction WarningMsg
hi default link MpiTranscriptBranch Type
hi default link MpiTranscriptError ErrorMsg
hi default link MpiTranscriptRule NonText

let s:tick = nr2char(96)
let s:lines = getline(1, '$')
let s:in_fence = {}
let s:tool_fences = []

function! s:role_heading(line) abort
  if a:line =~# '^## 👤 User' | return 'user' | endif
  if a:line =~# '^## 🤖 Assistant' | return 'assistant' | endif
  if a:line =~# '^## 📥 Injected' | return 'injected' | endif
  if a:line =~# '^## 📦 Compaction' | return 'compaction' | endif
  if a:line =~# '^## 🌿 Branch Summary' | return 'branch' | endif
  return ''
endfunction

function! s:tool_heading(line) abort
  return a:line =~# '^### 🔧 Tool'
endfunction

function! s:fence_open(line) abort
  return matchstr(a:line, '^' . s:tick . '\\+')
endfunction

function! s:heading_hl(line) abort
  if a:line =~# '^## 👤 User' | return 'MpiTranscriptUser' | endif
  if a:line =~# '^## 🤖 Assistant' | return 'MpiTranscriptAssistant' | endif
  if a:line =~# '^### 🔧 Tool'
    return a:line =~# '❌' ? 'MpiTranscriptError' : 'MpiTranscriptTool'
  endif
  if a:line =~# '^### 📘 Skill' | return 'MpiTranscriptSkill' | endif
  if a:line =~# '^## 📥 Injected' | return 'MpiTranscriptInjected' | endif
  if a:line =~# '^## 📦 Compaction' | return 'MpiTranscriptCompaction' | endif
  if a:line =~# '^## 🌿 Branch Summary' | return 'MpiTranscriptBranch' | endif
  return ''
endfunction

function! MpiTranscriptFoldtext() abort
  let l:s = v:foldstart
  let l:e = v:foldend
  let l:name = 'tool'
  let l:k = l:s
  while l:k >= 1
    let l:line = getline(l:k)
    if s:tool_heading(l:line)
      let l:raw = matchstr(l:line, 'Tool:\\s*\\zs.\\{-}\\ze\\s*—')
      if l:raw ==# ''
        let l:raw = matchstr(l:line, 'Tool:\\s*\\zs.*')
      endif
      let l:name = substitute(substitute(l:raw, '^\\s\\+', '', ''), '\\s\\+$', '', '')
      if l:name ==# '' | let l:name = 'tool' | endif
      break
    endif
    let l:k -= 1
  endwhile
  let l:open = getline(max([1, l:s - 1]))
  let l:lang = matchstr(l:open, s:tick . '\\+\\zs\\w*')
  let l:io = l:lang ==# 'json' ? 'in' : 'out'
  return '  ▸ ' . l:name . ' ' . l:io . ' · ' . (l:e - l:s + 1) . ' lines'
endfunction
setlocal foldtext=MpiTranscriptFoldtext()

let s:scan = 1
while s:scan <= len(s:lines)
  if !s:tool_heading(s:lines[s:scan - 1])
    let s:scan += 1
  else
    let s:scan += 1
    while s:scan <= len(s:lines)
      if s:lines[s:scan - 1] =~# '^\\s*$'
        let s:scan += 1
      else
        let s:ticks = s:fence_open(s:lines[s:scan - 1])
        if s:ticks ==# ''
          break
        endif
        let s:close = s:scan + 1
        while s:close <= len(s:lines) && s:lines[s:close - 1] !~# '^' . s:ticks
          let s:close += 1
        endwhile
        let s:k = s:scan
        while s:k <= min([s:close, len(s:lines)])
          let s:in_fence[s:k] = 1
          let s:k += 1
        endwhile
        call add(s:tool_fences, {'open': s:scan, 'close': s:close})
        let s:scan = min([s:close, len(s:lines)]) + 1
      endif
    endwhile
  endif
endwhile

let s:i = 1
while s:i <= len(s:lines)
  if !has_key(s:in_fence, s:i)
    let s:line = s:lines[s:i - 1]
    if s:line ==# '---'
      execute 'syntax match MpiTranscriptRule /^\\%' . s:i . 'l---$/ conceal cchar=─ containedin=ALL'
    else
      let s:hl = s:heading_hl(s:line)
      if s:hl !=# ''
        call matchaddpos(s:hl, [s:i])
        if s:line =~# '^### '
          execute 'syntax match MpiTranscriptHide /^\\%' . s:i . 'l### / conceal containedin=ALL'
        else
          execute 'syntax match MpiTranscriptHide /^\\%' . s:i . 'l## / conceal containedin=ALL'
        endif
      endif
    endif
  endif
  let s:i += 1
endwhile

let s:t = 1
while s:t <= len(s:lines)
  let s:line = s:lines[s:t - 1]
  if s:line =~# '^_🔄' || s:line =~# '^_\\d\\d\\d\\d-' || s:line =~# '^_.* · \\d\\d\\d\\d-'
    call matchaddpos('Comment', [s:t])
    if s:line =~# '^_.*_$' && strlen(s:line) >= 2
      execute 'syntax match MpiTranscriptHide /^\\%' . s:t . 'l_/ conceal containedin=ALL'
      execute 'syntax match MpiTranscriptHide /\\%' . s:t . 'l_$/ conceal containedin=ALL'
    endif
    let s:t += 1
  elseif s:line =~# '^>' && s:line =~# '💭 Thinking'
    while s:t <= len(s:lines) && s:lines[s:t - 1] =~# '^>'
      call matchaddpos('Comment', [s:t])
      let s:t += 1
    endwhile
  else
    let s:t += 1
  endif
endwhile

for s:f in s:tool_fences
  if s:f.close <= len(s:lines) && s:f.close - s:f.open > 1
    execute 'silent ' . (s:f.open + 1) . ',' . (s:f.close - 1) . 'fold'
  endif
endfor

let g:MpiTranscriptTurns = []
let g:MpiTranscriptUsers = []
let s:n = 1
while s:n <= len(s:lines)
  if !has_key(s:in_fence, s:n)
    let s:kind = s:role_heading(s:lines[s:n - 1])
    if s:kind ==# 'user' || s:kind ==# 'assistant'
      let s:turn = {'lnum': s:n, 'text': s:lines[s:n - 1]}
      call add(g:MpiTranscriptTurns, s:turn)
      if s:kind ==# 'user'
        call add(g:MpiTranscriptUsers, s:turn)
      endif
    endif
  endif
  let s:n += 1
endwhile

function! MpiTranscriptStatus() abort
  let l:lnum = line('.')
  let l:info = {}
  for l:t in g:MpiTranscriptTurns
    if l:t.lnum <= l:lnum
      let l:info = l:t
    else
      break
    endif
  endfor
  if empty(l:info)
    return ''
  endif
  let l:h = substitute(l:info.text, '^#\\+\\s\\+', '', '')
  let l:below = getline(l:info.lnum + 1)
  if l:below ==# ''
    let l:below = getline(l:info.lnum + 2)
  endif
  let l:dur = matchstr(l:below, '· \\zs[0-9.]\\+s\\ze · [0-9][0-9][0-9][0-9]-')
  if l:dur ==# ''
    let l:dur = matchstr(l:below, '· \\zs[0-9]\\+m [0-9]\\+s\\ze · [0-9][0-9][0-9][0-9]-')
  endif
  if l:dur !=# ''
    let l:h = l:h . ' · ' . l:dur
  endif
  return l:h
endfunction

set laststatus=2
setlocal statusline=\\ %{MpiTranscriptStatus()}%=[t/]t\\ turn\\ \\ [u/]u\\ user

function! MpiTranscriptJump(which, dir) abort
  let l:list = a:which ==# 'u' ? g:MpiTranscriptUsers : g:MpiTranscriptTurns
  let l:lnum = line('.')
  if a:dir > 0
    for l:t in l:list
      if l:t.lnum > l:lnum
        call cursor(l:t.lnum, 1)
        return
      endif
    endfor
  else
    let l:i = len(l:list) - 1
    while l:i >= 0
      if l:list[l:i].lnum < l:lnum
        call cursor(l:list[l:i].lnum, 1)
        return
      endif
      let l:i -= 1
    endwhile
  endif
endfunction

nnoremap <buffer> <silent> <nowait> ]t :call MpiTranscriptJump('t', 1)<CR>
nnoremap <buffer> <silent> <nowait> [t :call MpiTranscriptJump('t', -1)<CR>
nnoremap <buffer> <silent> <nowait> ]u :call MpiTranscriptJump('u', 1)<CR>
nnoremap <buffer> <silent> <nowait> [u :call MpiTranscriptJump('u', -1)<CR>
`;

// Open `content` in an external editor on the inherited tty. TUI state is
// always restored before the result is returned to the caller.
function openInExternalEditor(
  ctx: {
    ui: {
      custom<T>(
        factory: (
          tui: TUI,
          theme: unknown,
          keybindings: unknown,
          done: (result: T) => void,
        ) => Component,
      ): Promise<T>;
    };
  },
  editorCmd: string,
  content: string,
): Promise<ExternalEditorResult> {
  return ctx.ui.custom<ExternalEditorResult>((tui, _theme, _keybindings, done) => {
    const t = tui as unknown as {
      stop: () => void;
      start: () => void;
      requestRender: (f?: boolean) => void;
    };
    t.stop();
    const tmpFile = path.join(os.tmpdir(), `transcript-${process.pid}-${Date.now()}.md`);
    let scriptFile: string | undefined;
    const [cmd, ...cmdArgs] = editorCmd.split(" ").filter(Boolean);
    let resumed = false;
    const resume = (result: ExternalEditorResult) => {
      if (resumed) return;
      resumed = true;
      // node:fs — pure pi runs on Node; Bun.file is unavailable there.
      void fs.unlink(tmpFile).catch(() => {
        /* ENOENT: tmp already gone */
      });
      if (scriptFile) {
        void fs.unlink(scriptFile).catch(() => {
          /* ENOENT: tmp already gone */
        });
      }
      t.start();
      t.requestRender(true);
      done(result);
    };
    void (async () => {
      try {
        if (!cmd) throw new Error("External editor command is empty");
        await fs.writeFile(tmpFile, `${content}\n`);
        const base = path.basename(cmd);
        if (base === "nvim" || base === "vim") {
          scriptFile = tmpFile.replace(/\.md$/, base === "nvim" ? ".lua" : ".vim");
          await fs.writeFile(
            scriptFile,
            base === "nvim" ? NVIM_TRANSCRIPT_LUA : VIM_TRANSCRIPT_VIM,
          );
        }
        const child = spawn(cmd, [...cmdArgs, ...editorExtraArgs(cmd, scriptFile), tmpFile], {
          stdio: "inherit",
        });
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
          },
        );
        if (exit.code !== 0) {
          const reason = exit.signal ?? exit.code ?? "unknown";
          throw new Error(`External editor exited with ${reason}`);
        }
        resume({ ok: true });
      } catch (error) {
        resume({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return { render: () => [], invalidate: () => {}, handleInput: () => {} };
  });
}

// ─── Extension entry point ────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi) => {
  const agentDir = getAgentDir();
  // Read live rather than snapshotted at startup, so the estimate reflects the
  // tools currently enabled and the system prompt as it stands now.
  const resolveContextPrefix = (ctx: {
    getSystemPromptOptions(): BuildSystemPromptOptions;
  }): ContextPrefix => {
    const active = new Set(pi.getActiveTools());
    return {
      systemPrompt: buildSystemPrompt(ctx.getSystemPromptOptions()),
      tools: pi.getAllTools().filter((tool) => active.has(tool.name)),
    };
  };

  type UiCtx = {
    ui: {
      select(title: string, options: string[]): Promise<string | undefined>;
      notify(message: string, type?: "info" | "warning" | "error"): void;
    };
  };

  // Parse "/transcript [target] [N] [full]" (or bare "/transcript N"). Returns undefined
  // after notifying on any invalid token — no silent recovery.
  const parseArgs = (
    args: string,
    ctx: UiCtx,
  ): { targetToken?: string; lastTurns?: number; fullToolOutput?: boolean } | undefined => {
    const allTokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    // "full" is positionless: strip every occurrence before positional parsing.
    const tokens = allTokens.filter((t) => t.toLowerCase() !== "full");
    const fullToolOutput = tokens.length < allTokens.length;
    if (tokens.length > 2) {
      ctx.ui.notify("Error: Usage: /transcript [target] [N] [full]", "error");
      return undefined;
    }
    let targetToken: string | undefined;
    let countToken: string | undefined;
    if (tokens.length === 2) [targetToken, countToken] = tokens as [string, string];
    else if (tokens.length === 1) {
      if (/^\d+$/.test(tokens[0]!)) countToken = tokens[0];
      else targetToken = tokens[0];
    }
    let lastTurns: number | undefined;
    if (countToken !== undefined) {
      const n = Number(countToken);
      if (!Number.isInteger(n) || n < 1) {
        ctx.ui.notify(
          `Error: Invalid turn count: ${countToken}. Expected a positive integer.`,
          "error",
        );
        return undefined;
      }
      lastTurns = n;
    }
    return { targetToken, lastTurns, fullToolOutput };
  };

  // Resolve the target: explicit token, or the select chooser when absent.
  // Returns undefined when the user cancels or passes an unknown id.
  const resolveTarget = async (
    targetToken: string | undefined,
    ctx: UiCtx,
  ): Promise<TargetId | undefined> => {
    if (targetToken) {
      const target = normalizeTarget(targetToken);
      if (!target) {
        ctx.ui.notify(
          `Error: Unknown transcript target: ${targetToken}. Try: ${TARGETS.map((t) => t.id).join(", ")}`,
          "error",
        );
      }
      return target;
    }
    const labels = TARGETS.map((t) => t.label);
    const picked = await ctx.ui.select("Which content would you like to view?", labels);
    if (picked === undefined) return undefined;
    return TARGETS.find((t) => t.label === picked)?.id;
  };

  const openTranscriptConfig = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!ctx.hasUI) {
      ctx.ui.notify("/transcript config requires interactive UI.", "error");
      return;
    }
    const loaded = loadTranscriptConfig(agentDir);
    if (!loaded.ok) {
      ctx.ui.notify(transcriptConfigError(loaded), "error");
      return;
    }
    const options = transcriptEditorOptions();
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
      createTranscriptConfigOverlay({
        theme,
        requestRender: () => tui.requestRender(),
        done: () => done(undefined),
        configPath: loaded.path,
        initial: loaded.config,
        options,
        persist: (config) => {
          const written = writeTranscriptConfig(agentDir, config);
          return written.ok
            ? { ok: true, config: written.config }
            : { ok: false, error: `${written.path}: ${written.error}` };
        },
        onError: (message) => ctx.ui.notify(message, "error"),
      }),
    );
  };

  const openView = async (
    target: TargetId,
    lastTurns: number | undefined,
    fullToolOutput: boolean | undefined,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    // context = the effective LLM context (branch resolution, compaction,
    // summaries applied); other targets read the full branch.
    const entries =
      target === "context"
        ? ctx.sessionManager.buildContextEntries()
        : ctx.sessionManager.getBranch();
    const meta = TARGETS.find((t) => t.id === target)!;
    const content = buildViewText(target, entries, {
      lastTurns,
      fullToolOutput,
      contextPrefix: target === "context" ? resolveContextPrefix(ctx) : undefined,
      contextWindowFor: (provider, modelId) =>
        resolveModel(ctx.modelRegistry, provider, modelId)?.contextWindow,
      priceSource: {
        getModel: (provider, modelId) => resolveModel(ctx.modelRegistry, provider, modelId),
      },
      sessionFile: ctx.sessionManager.getSessionFile(),
    });
    const loaded = loadTranscriptConfig(agentDir);
    if (!loaded.ok) {
      ctx.ui.notify(transcriptConfigError(loaded), "error");
      return;
    }
    const mode = loaded.config.editor;
    const editorCmd = resolveTranscriptEditor(mode);
    if (!editorCmd) {
      await ctx.ui.editor(meta.title, content);
      return;
    }
    const result = await openInExternalEditor(ctx, editorCmd, content);
    if (result.ok) return;
    ctx.ui.notify(result.error, "error");
    await ctx.ui.editor(meta.title, content);
  };

  pi.registerCommand("transcript", {
    description:
      "View transcript slices or configure the editor; N = last N turns, full = untruncated tool output",
    getArgumentCompletions: (prefix: string) =>
      [
        ...TARGETS.map((t) => ({ value: t.id, label: t.id, description: t.label })),
        { value: "config", label: "config", description: "Choose the transcript editor" },
        { value: "full", label: "full", description: "Untruncated tool output" },
      ].filter((item) => item.value.startsWith(prefix.trim())),
    handler: async (args, ctx) => {
      if ((args ?? "").trim().toLowerCase() === "config") {
        await openTranscriptConfig(ctx);
        return;
      }
      const parsed = parseArgs(args, ctx);
      if (!parsed) return;
      const target = await resolveTarget(parsed.targetToken, ctx);
      if (!target) return;
      if (
        parsed.lastTurns !== undefined &&
        (target === "latest-agent" || target === "latest-user")
      ) {
        ctx.ui.notify(`Error: Turn count is not supported for ${target}.`, "error");
        return;
      }
      if (parsed.fullToolOutput && target !== "chatlog" && target !== "context") {
        ctx.ui.notify(`Error: full is not supported for ${target}.`, "error");
        return;
      }
      await openView(target, parsed.lastTurns, parsed.fullToolOutput, ctx);
    },
  });
};

export default extension;

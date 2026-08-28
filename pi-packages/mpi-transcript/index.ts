// ╔══════════════════════════════════════════════════════════════════╗
// ║      transcript: View session transcript slices in the editor      ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║                                                                    ║
// ║  /transcript [target] [N] [full]                                  ║
// ║      N = last N rounds (chatlog/thinking)                         ║
// ║      full = untruncated tool output (chatlog/context)             ║
// ║                                                                    ║
// ║  Rebuilds the requested slice of the current session branch and    ║
// ║  opens it in the user's external editor ($VISUAL/$EDITOR), falling  ║
// ║  back to the in-app multi-line editor (ctx.ui.editor) when none is   ║
// ║  configured. For scrolling and copying; nothing is written to disk. ║
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
import {
  CACHE_TTL_MS,
  buildSystemPrompt,
  collectCacheMisses,
  estimateTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  BuildSystemPromptOptions,
  CacheMiss,
  ExtensionFactory,
  ModelPriceSource,
  SessionEntry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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
function messageOf(entry: SessionEntry): { role: string; content: unknown } | undefined {
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

// Full transcript as markdown sections: numbered user/assistant rounds,
// injected context, compaction/branch summaries, tool calls (paired to their
// results by toolCallId), thinking quotes, and error/abort markers.
/** Tokens as a compact k-suffixed figure: 8432 → "8.4k", 200000 → "200k". */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/** Resolves a model's context window in tokens; undefined when unknown. */
type ContextWindowLookup = (provider: string, modelId: string) => number | undefined;

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
    ? `~${fmtTokens(estimate.total)}/${fmtTokens(contextWindow)} (${((estimate.total / contextWindow) * 100).toFixed(1)}%)`
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
          parts.push(`### 🔧 Tool: \`${name}\` — ${status}${argsBlock}${body}`);
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
              meta.push(`${fmtTokens(ctxTokens)}/${fmtTokens(cw)} (${inner})`);
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
  const { lastTurns, contextWindowFor, priceSource, fullToolOutput, contextPrefix } = options;
  const meta = TARGETS.find((t) => t.id === target)!;
  if (target === "thinking" || target === "chatlog" || target === "context") {
    const { sliced, turnOffset } = cutForLastTurns(entries, lastTurns);
    const note =
      turnOffset > 0
        ? [`_… earlier ${turnOffset} turn${turnOffset === 1 ? "" : "s"} omitted_`]
        : [];
    if (target === "thinking") {
      const thinking = collectThinking(sliced, turnOffset);
      return formatViewText(meta.title, [
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
      ...sizeLine,
      ...note,
      ...collectChatlog(sliced, { turnOffset, contextWindowFor, cacheMisses, fullToolOutput }),
    ]);
  }
  if (target === "latest-agent") {
    return formatViewText(meta.title, [latestAgentReply(entries) ?? "No assistant message."]);
  }
  return formatViewText(meta.title, [latestUserMessage(entries) ?? "No user message."]);
}

// ─── Display: external editor (default) with in-app editor fallback ───────────

/** The user's configured external editor command, or undefined when none. */
function externalEditorCommand(): string | undefined {
  return process.env.VISUAL || process.env.EDITOR || undefined;
}

/**
 * Extra CLI flags for vim/nvim (matched on the binary's basename): readonly
 * (the buffer is a throwaway view, nothing is written back), no swap file,
 * no shada/viminfo writes (the tmp file must not pollute oldfiles/marks),
 * and jump to the end where the latest content lives. nvim also sources
 * `luafile` (winbar, heading colors, wrap/conceal) when a path is given.
 * Other editors get none.
 */
export function editorExtraArgs(cmd: string, luafile?: string): string[] {
  const base = path.basename(cmd);
  if (base !== "nvim" && base !== "vim") return [];
  const args = ["-R", "-n", "-i", "NONE", "+normal G"];
  if (base === "nvim" && luafile) args.push("-c", `luafile ${luafile}`);
  return args;
}

/** Sourced into nvim after the transcript buffer loads (`-c luafile`). */
export const NVIM_TRANSCRIPT_LUA = `
vim.opt_local.conceallevel = 2
vim.opt_local.wrap = true
vim.opt_local.linebreak = true
vim.opt_local.signcolumn = "no"
vim.opt_local.foldmethod = "manual"
vim.opt_local.foldenable = true
vim.opt_local.fillchars:append({ fold = " " })

vim.api.nvim_set_hl(0, "MpiTranscriptTurn", { default = true, link = "Identifier" })

vim.fn.matchadd("Title", [[^## 👤 User.*]])
vim.fn.matchadd("Identifier", [[^## 🤖 Assistant.*]])
vim.fn.matchadd("Statement", [[^### 🔧 Tool.*]])
vim.fn.matchadd("Special", [[^## 📥 Injected.*]])
vim.fn.matchadd("WarningMsg", [[^## 📦 Compaction.*]])
vim.fn.matchadd("Type", [[^## 🌿 Branch Summary.*]])

local buf = vim.api.nvim_get_current_buf()
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
      name = raw:gsub(tick3:sub(1, 1), ""):gsub("^%s+", ""):gsub("%s+$", "")
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

-- Role marks are rendered by MpiTranscriptStc below instead of legacy signs:
-- the native sign column ('%s') renders with a different width/highlight on
-- wrapped continuation rows and is resized by unrelated user plugins, which
-- shifts the turn bar. signcolumn=no keeps plugin signs out of this view.
local stc_marks = {}
for i, line in ipairs(lines) do
  local mark
  if line:match([[^## 👤 User]]) then
    mark = { text = "U ", hl = "Title" }
  elseif line:match([[^## 🤖 Assistant]]) then
    mark = { text = "A ", hl = "Identifier" }
  elseif line:match([[^### 🔧 Tool]]) then
    mark = line:match("❌") and { text = "E ", hl = "ErrorMsg" } or { text = "T ", hl = "Statement" }
  elseif line:match([[^## 📥 Injected]]) then
    mark = { text = "I ", hl = "Special" }
  elseif line:match([[^## 📦 Compaction]]) then
    mark = { text = "C ", hl = "WarningMsg" }
  elseif line:match([[^## 🌿 Branch Summary]]) then
    mark = { text = "B ", hl = "Type" }
  end
  if mark then stc_marks[i] = mark end
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

-- Only the fences that sit directly under a Tool heading (args + result).
-- Stop at the first non-blank, non-fence line so model-written markdown is left alone.
local i = 1
while i <= #lines do
  if not tool_heading(lines[i]) then
    i = i + 1
  else
    i = i + 1
    while i <= #lines do
      if lines[i]:match("^%s*$") then
        i = i + 1
      else
        local ticks = fence_open(lines[i])
        if not ticks then break end
        local j = i + 1
        while j <= #lines and not lines[j]:match("^" .. ticks) do
          j = j + 1
        end
        if j <= #lines and j - i > 1 then
          vim.cmd(("silent %d,%dfold"):format(i + 1, j - 1))
        end
        i = math.max(j, i) + 1
      end
    end
  end
end

local turns = {}
for n, line in ipairs(lines) do
  local kind = role_heading(line)
  if kind == "user" or kind == "assistant" then
    turns[#turns + 1] = { lnum = n, text = line }
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
-- turn bar. Build the whole column (role mark, bar, number) in one function
-- that emits identical-width content for every screen row of a line.
function _G.MpiTranscriptStc()
  local t = _G.MpiTranscriptTurn
  local l = vim.v.lnum
  local bar = (t and l > t.s and l <= t.e) and "│" or " "
  local virt = vim.v.virtnum > 0
  local m = not virt and stc_marks[l] or nil
  local mark = m and ("%#" .. m.hl .. "#" .. m.text) or "  "
  local num = virt and string.rep(" ", #tostring(l)) or tostring(l)
  return mark .. "%#MpiTranscriptTurn#" .. bar .. "%#LineNr#" .. num .. " "
end
vim.opt_local.statuscolumn = "%!v:lua.MpiTranscriptStc()"

local function refresh()
  local s, e, info = turn_at(vim.api.nvim_win_get_cursor(0)[1])
  _G.MpiTranscriptTurn.s = s
  _G.MpiTranscriptTurn.e = e
  local h = heading_label(info)
  local keys = "%=[t prev  ]t next"
  vim.wo.winbar = h == "" and keys or (" " .. h:gsub("%%", "%%%%") .. keys)
end

local function jump_role(dir)
  local lnum = vim.api.nvim_win_get_cursor(0)[1]
  if dir > 0 then
    for _, t in ipairs(turns) do
      if t.lnum > lnum then
        vim.api.nvim_win_set_cursor(0, { t.lnum, 0 })
        return
      end
    end
  else
    for i = #turns, 1, -1 do
      if turns[i].lnum < lnum then
        vim.api.nvim_win_set_cursor(0, { turns[i].lnum, 0 })
        return
      end
    end
  end
end
vim.keymap.set("n", "]t", function() jump_role(1) end, { buffer = true, silent = true })
vim.keymap.set("n", "[t", function() jump_role(-1) end, { buffer = true, silent = true })

vim.api.nvim_create_autocmd("CursorMoved", {
  buffer = 0,
  callback = refresh,
})
refresh()
`;

// Open `content` in the user's $VISUAL/$EDITOR. Follows the diff-tracker
// pattern: pause the TUI via ctx.ui.custom, spawn the editor on the inherited
// tty, and resume once it exits. Resolves true on success, false if the editor
// could not be launched (so the caller can fall back to the in-app editor).
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
): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, _theme, _keybindings, done) => {
    const t = tui as unknown as {
      stop: () => void;
      start: () => void;
      requestRender: (f?: boolean) => void;
    };
    t.stop();
    const tmpFile = path.join(os.tmpdir(), `transcript-${process.pid}-${Date.now()}.md`);
    let luaFile: string | undefined;
    // Split so `EDITOR="code -w"` style commands keep their flags.
    const [cmd, ...cmdArgs] = editorCmd.split(" ").filter(Boolean);
    // Resume exactly once (a double start leaks a resize listener).
    let resumed = false;
    const resume = (ok: boolean) => {
      if (resumed) return;
      resumed = true;
      // node:fs — pure pi runs on Node; Bun.file is unavailable there.
      void fs.unlink(tmpFile).catch(() => {
        /* ENOENT: tmp already gone */
      });
      if (luaFile) {
        void fs.unlink(luaFile).catch(() => {
          /* ENOENT: tmp already gone */
        });
      }
      t.start();
      t.requestRender(true);
      done(ok);
    };
    void (async () => {
      try {
        await fs.writeFile(tmpFile, `${content}\n`);
        if (path.basename(cmd!) === "nvim") {
          luaFile = tmpFile.replace(/\.md$/, ".lua");
          await fs.writeFile(luaFile, NVIM_TRANSCRIPT_LUA);
        }
        const child = spawn(cmd!, [...cmdArgs, ...editorExtraArgs(cmd!, luaFile), tmpFile], {
          stdio: "inherit",
        });
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", () => resolve());
        });
        resume(true);
      } catch {
        resume(false);
      }
    })();
    return { render: () => [], invalidate: () => {}, handleInput: () => {} };
  });
}

// ─── Extension entry point ────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi) => {
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

  // Default to the user's external editor ($VISUAL/$EDITOR); fall back to the
  // in-app multi-line editor when none is configured or it fails to launch.
  const openView = async (
    target: TargetId,
    lastTurns: number | undefined,
    fullToolOutput: boolean | undefined,
    ctx: {
      sessionManager: {
        getBranch: () => SessionEntry[];
        buildContextEntries: () => SessionEntry[];
      };
      modelRegistry: {
        find(
          provider: string,
          modelId: string,
        ): { contextWindow: number; cost: { cacheRead: number } } | undefined;
      };
      ui: {
        editor(title: string, prefill?: string): Promise<string | undefined>;
        custom<T>(
          factory: (
            tui: TUI,
            theme: unknown,
            keybindings: unknown,
            done: (result: T) => void,
          ) => Component,
        ): Promise<T>;
      };
      getSystemPromptOptions(): BuildSystemPromptOptions;
    },
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
        ctx.modelRegistry.find(provider, modelId)?.contextWindow,
      priceSource: { getModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId) },
    });
    const editorCmd = externalEditorCommand();
    if (editorCmd && (await openInExternalEditor(ctx, editorCmd, content))) return;
    await ctx.ui.editor(meta.title, content);
  };

  pi.registerCommand("transcript", {
    description:
      "View context (effective LLM view), chatlog, thinking, latest-agent, or latest-user text; N = last N turns, full = untruncated tool output",
    getArgumentCompletions: (prefix: string) =>
      [
        ...TARGETS.map((t) => ({ value: t.id, label: t.id, description: t.label })),
        { value: "full", label: "full", description: "Untruncated tool output" },
      ].filter((item) => item.value.startsWith(prefix.trim())),
    handler: async (args, ctx) => {
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

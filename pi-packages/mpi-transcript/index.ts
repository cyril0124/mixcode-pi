// ╔══════════════════════════════════════════════════════════════════╗
// ║      transcript: View session transcript slices in the editor      ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║                                                                    ║
// ║  /transcript [target] [N]   N = last N rounds (chatlog/thinking)  ║
// ║                                                                    ║
// ║  Rebuilds the requested slice of the current session branch and    ║
// ║  opens it in the user's external editor ($VISUAL/$EDITOR), falling  ║
// ║  back to the in-app multi-line editor (ctx.ui.editor) when none is   ║
// ║  configured. For scrolling and copying; nothing is written to disk. ║
// ║                                                                    ║
// ║  Targets:                                                          ║
// ║    chatlog       Full transcript (user/assistant/thinking/tools/   ║
// ║                  injected/compaction/branch summaries/errors)      ║
// ║    context       Effective LLM context (what the model sees)       ║
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
import type { ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
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
  { id: "chatlog", title: "Chat Export", label: "Chatlog" },
  { id: "context", title: "LLM Context", label: "Context (as the LLM sees it)" },
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
 * Markdown output: `# <title>` followed by blank-line-separated sections,
 * with trailing whitespace stripped from every line.
 */
export function formatViewText(title: string, body: string[]): string {
  return [`# ${title}`, ...body].join("\n\n").replace(/[ \t]+$/gm, "");
}

// ─── Content reconstruction from the session branch ───────────────────────────

/** Narrow a branch entry to its message when it is a normal chat message. */
function messageOf(entry: SessionEntry): { role: string; content: unknown } | undefined {
  if (entry.type !== "message") return undefined;
  return entry.message as unknown as { role: string; content: unknown };
}

/**
 * Flatten a message's content (string or block array) to plain text.
 * Image blocks render as a `🖼️ [image]` placeholder.
 */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type: string; text?: string };
      if (b.type === "image") return "🖼️ [image]";
      return b.text !== undefined ? b.text : "";
    })
    .filter((text) => text.trim())
    .join("\n");
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
function collectChatlog(entries: SessionEntry[], turnOffset = 0): string[] {
  const resultById = new Map<string, { status: string; text: string }>();
  for (const entry of entries) {
    const msg = messageOf(entry) as
      | { role: string; toolCallId?: string; toolName?: string; content?: unknown; isError?: boolean }
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
  for (const entry of entries) {
    // One-line timeline events: model / thinking level switches explain why
    // the conversation's behavior changed mid-session.
    if (entry.type === "model_change") {
      sections.push(`---\n\n_⚙️ model → ${entry.provider}/${entry.modelId}_`);
      continue;
    }
    if (entry.type === "thinking_level_change") {
      sections.push(`---\n\n_⚙️ thinking → ${entry.thinkingLevel}_`);
      continue;
    }
    // Compaction replaces all prior context with its summary; branch summaries
    // stand in for another branch. Both are LLM-visible, so the chatlog must
    // show them or the transcript reads as if context appeared from nowhere.
    if (entry.type === "compaction") {
      const tokens = entry.tokensBefore.toLocaleString("en-US");
      sections.push(`---\n\n## 🗜️ Compaction · ${tokens} tokens before\n\n${entry.summary.trim()}`);
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
          model?: string;
          usage?: { totalTokens?: number; cost?: { total?: number } };
        }
      | undefined;
    if (!msg) continue;
    if (msg.role === "user") {
      const text = blockText(msg.content);
      if (text.trim()) {
        turn += 1;
        sections.push(`---\n\n## 👤 User · #${turn}\n\n_${formatTime(entry.timestamp)}_\n\n${text.trim()}`);
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
            parts.push(
              `> **💭 Thinking**\n>\n> ${text.trim().replace(/\n/g, "\n> ")}`,
            );
        } else if (block.type === "toolCall") {
          const call = block as ToolCallBlock;
          const result = call.id ? resultById.get(call.id) : undefined;
          const name = call.name ?? "(unknown)";
          // No paired result means the call never completed (e.g. aborted).
          const status = result ? (result.status === "error" ? "❌ error" : "✅ success") : "⏳ no result";
          // Tool call arguments as a fenced JSON block; empty/missing args render nothing.
          const args = call.arguments && Object.keys(call.arguments).length ? call.arguments : undefined;
          let argsBlock = "";
          if (args) {
            const json = JSON.stringify(args, null, 2);
            const f = fenceFor(json);
            argsBlock = `\n\n${f}json\n${json}\n${f}`;
          }
          // Tool output in a fence sized past any fence inside it, truncated so
          // one big read/bash result cannot drown the transcript.
          const resultText = result?.text.trim() ?? "";
          let body = "";
          if (resultText) {
            const lines = resultText.split("\n");
            const kept = lines.slice(0, TOOL_RESULT_MAX_LINES).join("\n");
            const f = fenceFor(kept);
            const more = lines.length - TOOL_RESULT_MAX_LINES;
            body = `\n\n${f}\n${kept}\n${f}${more > 0 ? `\n\n_… +${more} more lines_` : ""}`;
          }
          parts.push(`### 🔧 Tool: \`${name}\` — ${status}${argsBlock}${body}`);
        }
      }
      // Surface failed/interrupted turns; without this an errored turn with no
      // text would vanish from the transcript.
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        parts.push(`**⚠️ ${msg.stopReason}**${msg.errorMessage ? `: ${msg.errorMessage}` : ""}`);
      }
      if (parts.length) {
        // Meta line: model, token/cost totals (omitted when zero), timestamp.
        const meta: string[] = [];
        if (msg.model) meta.push(msg.model);
        if (msg.usage?.totalTokens) meta.push(`${msg.usage.totalTokens.toLocaleString("en-US")} tok`);
        if (msg.usage?.cost?.total) meta.push(`$${msg.usage.cost.total.toFixed(4)}`);
        meta.push(formatTime(entry.timestamp));
        sections.push(
          `---\n\n## 🤖 Assistant${turn > 0 ? ` · #${turn}` : ""}\n\n_${meta.join(" · ")}_\n\n${parts.join("\n\n")}`,
        );
      }
    }
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

/**
 * Build the final editor text for a target from the session branch.
 * `lastTurns` (chatlog/thinking only) restricts output to the last N rounds;
 * omitted rounds are announced in a leading notice line.
 */
export function buildViewText(target: TargetId, entries: SessionEntry[], lastTurns?: number): string {
  const meta = TARGETS.find((t) => t.id === target)!;
  if (target === "thinking" || target === "chatlog" || target === "context") {
    const { sliced, turnOffset } = cutForLastTurns(entries, lastTurns);
    const note =
      turnOffset > 0 ? [`_… earlier ${turnOffset} turn${turnOffset === 1 ? "" : "s"} omitted_`] : [];
    if (target === "thinking") {
      const thinking = collectThinking(sliced, turnOffset);
      return formatViewText(meta.title, [...note, ...(thinking.length ? thinking : ["No thinking entries."])]);
    }
    // chatlog and context share the section renderer; they differ only in
    // which entry set the caller feeds in (full branch vs effective context).
    return formatViewText(meta.title, [...note, ...collectChatlog(sliced, turnOffset)]);
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
 * and jump to the end where the latest content lives. Other editors get none.
 */
export function editorExtraArgs(cmd: string): string[] {
  const base = path.basename(cmd);
  return base === "nvim" || base === "vim" ? ["-R", "-n", "-i", "NONE", "+normal G"] : [];
}

// Open `content` in the user's $VISUAL/$EDITOR. Follows the diff-tracker
// pattern: pause the TUI via ctx.ui.custom, spawn the editor on the inherited
// tty, and resume once it exits. Resolves true on success, false if the editor
// could not be launched (so the caller can fall back to the in-app editor).
function openInExternalEditor(
  ctx: { ui: { custom<T>(factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component): Promise<T> } },
  editorCmd: string,
  content: string,
): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, _theme, _keybindings, done) => {
    const t = tui as unknown as { stop: () => void; start: () => void; requestRender: (f?: boolean) => void };
    t.stop();
    const tmpFile = path.join(os.tmpdir(), `transcript-${process.pid}-${Date.now()}.md`);
    // Split so `EDITOR="code -w"` style commands keep their flags.
    const [cmd, ...cmdArgs] = editorCmd.split(" ").filter(Boolean);
    // Resume exactly once (a double start leaks a resize listener).
    let resumed = false;
    const resume = (ok: boolean) => {
      if (resumed) return;
      resumed = true;
      // node:fs — pure pi runs on Node; Bun.file is unavailable there.
      void fs.unlink(tmpFile).catch(() => {
        /* best effort */
      });
      t.start();
      t.requestRender(true);
      done(ok);
    };
    void (async () => {
      try {
        await fs.writeFile(tmpFile, `${content}\n`);
        const child = spawn(cmd!, [...cmdArgs, ...editorExtraArgs(cmd!), tmpFile], { stdio: "inherit" });
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
  type UiCtx = {
    ui: {
      select(title: string, options: string[]): Promise<string | undefined>;
      notify(message: string, type?: "info" | "warning" | "error"): void;
    };
  };

  // Parse "/transcript [target] [N]" (or bare "/transcript N"). Returns undefined after
  // notifying on any invalid token — no silent recovery.
  const parseArgs = (
    args: string,
    ctx: UiCtx,
  ): { targetToken?: string; lastTurns?: number } | undefined => {
    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 2) {
      ctx.ui.notify("Error: Usage: /transcript [target] [N]", "error");
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
        ctx.ui.notify(`Error: Invalid turn count: ${countToken}. Expected a positive integer.`, "error");
        return undefined;
      }
      lastTurns = n;
    }
    return { targetToken, lastTurns };
  };

  // Resolve the target: explicit token, or the select chooser when absent.
  // Returns undefined when the user cancels or passes an unknown id.
  const resolveTarget = async (targetToken: string | undefined, ctx: UiCtx): Promise<TargetId | undefined> => {
    if (targetToken) {
      const target = normalizeTarget(targetToken);
      if (!target) {
        ctx.ui.notify(`Error: Unknown transcript target: ${targetToken}. Try: ${TARGETS.map((t) => t.id).join(", ")}`, "error");
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
    ctx: {
      sessionManager: { getBranch: () => SessionEntry[]; buildContextEntries: () => SessionEntry[] };
      ui: {
        editor(title: string, prefill?: string): Promise<string | undefined>;
        custom<T>(factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component): Promise<T>;
      };
    },
  ): Promise<void> => {
    // context = the effective LLM context (branch resolution, compaction,
    // summaries applied); other targets read the full branch.
    const entries =
      target === "context" ? ctx.sessionManager.buildContextEntries() : ctx.sessionManager.getBranch();
    const meta = TARGETS.find((t) => t.id === target)!;
    const content = buildViewText(target, entries, lastTurns);
    const editorCmd = externalEditorCommand();
    if (editorCmd && (await openInExternalEditor(ctx, editorCmd, content))) return;
    await ctx.ui.editor(meta.title, content);
  };

  pi.registerCommand("transcript", {
    description:
      "View chatlog, context (effective LLM view), thinking, latest-agent, or latest-user text; trailing N = last N turns",
    getArgumentCompletions: (prefix: string) =>
      TARGETS.map((t) => ({ value: t.id, label: t.id, description: t.label })).filter((item) =>
        item.value.startsWith(prefix.trim()),
      ),
    handler: async (args, ctx) => {
      const parsed = parseArgs(args, ctx);
      if (!parsed) return;
      const target = await resolveTarget(parsed.targetToken, ctx);
      if (!target) return;
      if (parsed.lastTurns !== undefined && (target === "latest-agent" || target === "latest-user")) {
        ctx.ui.notify(`Error: Turn count is not supported for ${target}.`, "error");
        return;
      }
      await openView(target, parsed.lastTurns, ctx);
    },
  });
};

export default extension;

// ╔══════════════════════════════════════════════════════════════════╗
// ║          chat-view: View conversation content in the editor        ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║                                                                    ║
// ║  /view [target]                                                    ║
// ║                                                                    ║
// ║  Rebuilds the requested slice of the current session branch and    ║
// ║  opens it in the user's external editor ($VISUAL/$EDITOR), falling  ║
// ║  back to the in-app multi-line editor (ctx.ui.editor) when none is   ║
// ║  configured. For scrolling and copying; nothing is written to disk. ║
// ║                                                                    ║
// ║  Targets:                                                          ║
// ║    chatlog       Full transcript (user/assistant/thinking/tools)   ║
// ║    thinking      All reasoning/thinking blocks                     ║
// ║    latest-agent  Last assistant text reply                         ║
// ║    latest-user   Last user message                                 ║
// ║                                                                    ║
// ║  Data source is the SDK-native session branch                      ║
// ║  (ctx.sessionManager.getBranch()), not any host-internal chat      ║
// ║  model, so the extension is portable across pi hosts.              ║
// ║                                                                    ║
// ╚══════════════════════════════════════════════════════════════════╝

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
}
type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string };

// ─── View targets ─────────────────────────────────────────────────────────────

/** Canonical target ids plus the human title rendered above the content. */
const TARGETS = [
  { id: "chatlog", title: "Chat Export", label: "Chatlog" },
  { id: "thinking", title: "Thinking Export", label: "Thinking" },
  { id: "latest-agent", title: "Latest Agent Reply", label: "Latest agent reply" },
  { id: "latest-user", title: "Latest User Message", label: "Latest user message" },
] as const;

type TargetId = (typeof TARGETS)[number]["id"];

/** Accept the canonical ids plus the historical long aliases. */
function normalizeTarget(raw: string): TargetId | undefined {
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "chatlog":
      return "chatlog";
    case "thinking":
      return "thinking";
    case "latest-agent":
    case "latest-agent-reply":
      return "latest-agent";
    case "latest-user":
    case "latest-user-message":
      return "latest-user";
    default:
      return undefined;
  }
}

// ─── Title formatting ───────────────────────────────────────────────────────
//
//   ---------------
//   Thinking Export
//   ---------------
//
//   <content>
//
// The divider width equals the title's character length (per product choice),
// with one blank line separating the header from the body.

export function formatViewText(title: string, body: string[]): string {
  return [`# ${title}`, ...body].join("\n\n");
}

// ─── Content reconstruction from the session branch ───────────────────────────

/** Narrow a branch entry to its message when it is a normal chat message. */
function messageOf(entry: SessionEntry): { role: string; content: unknown } | undefined {
  if (entry.type !== "message") return undefined;
  return entry.message as unknown as { role: string; content: unknown };
}

/** Flatten a message's content (string or block array) to plain text. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type: string; text?: string };
      return b.text !== undefined ? b.text : "";
    })
    .filter((text) => text.trim())
    .join("\n");
}

/** All thinking blocks across every assistant message, in order. */
function collectThinking(entries: SessionEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const msg = messageOf(entry);
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as AssistantBlock[]) {
      if (block.type !== "thinking") continue;
      const t = block as ThinkingBlock;
      const text = t.redacted ? "[Reasoning redacted]" : (t.thinking ?? "");
      // Indent each line so vim renders it as a blockquote-style indented block
      if (text.trim()) out.push(`---\n\n${text.trim()}`);
    }
  }
  return out;
}

/** Last assistant text reply (thinking/tool-only turns are skipped). */
function latestAgentReply(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = messageOf(entries[i]);
    if (msg?.role !== "assistant") continue;
    const text = blockText(msg.content);
    if (text.trim()) return text;
  }
  return undefined;
}

/** Last user message text. */
function latestUserMessage(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = messageOf(entries[i]);
    if (msg?.role !== "user") continue;
    const text = blockText(msg.content);
    if (text.trim()) return text;
  }
  return undefined;
}

// Full transcript. Tool calls and their results are paired by toolCallId so
// each tool line shows its final status/output, matching the host's prior
// chatlog output ([role] text, [tool:name:status] result).
function collectChatlog(entries: SessionEntry[]): string[] {
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
  for (const entry of entries) {
    const msg = messageOf(entry) as { role: string; content?: unknown } | undefined;
    if (!msg) continue;
    if (msg.role === "user") {
      const text = blockText(msg.content);
      if (text.trim()) sections.push(`---\n\n## 👤 User\n\n${text.trim()}`);
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content as AssistantBlock[]) {
        if (block.type === "text") {
          const text = (block as TextBlock).text ?? "";
          if (text.trim()) parts.push(text.trim());
        } else if (block.type === "thinking") {
          const t = block as ThinkingBlock;
          const text = t.redacted ? "[Reasoning redacted]" : (t.thinking ?? "");
          // Render thinking as a collapsed blockquote section
          if (text.trim())
            parts.push(
              `> **💭 Thinking**\n>\n> ${text.trim().replace(/\n/g, "\n> ")}`,
            );
        } else if (block.type === "toolCall") {
          const call = block as ToolCallBlock;
          const result = call.id ? resultById.get(call.id) : undefined;
          const name = call.name ?? "(unknown)";
          const status = result?.status === "error" ? "❌ error" : "✅ success";
          const resultText = result?.text.trim() ?? "";
          // Use indented code block for tool output
          const body = resultText ? `\n\n    ${resultText.replace(/\n/g, "\n    ")}` : "";
          parts.push(`**🔧 Tool: \`${name}\`** — _${status}_${body}`);
        }
      }
      if (parts.length) sections.push(`---\n\n## 🤖 Assistant\n\n${parts.join("\n\n")}`);
    }
  }
  return sections;
}

/** Build the final editor text for a target from the session branch. */
export function buildViewText(target: TargetId, entries: SessionEntry[]): string {
  const meta = TARGETS.find((t) => t.id === target)!;
  if (target === "thinking") {
    const thinking = collectThinking(entries);
    return formatViewText(meta.title, thinking.length ? thinking : ["No thinking entries."]);
  }
  if (target === "chatlog") {
    return formatViewText(meta.title, collectChatlog(entries));
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
    const tmpFile = path.join(os.tmpdir(), `chat-view-${process.pid}-${Date.now()}.md`);
    // Split so `EDITOR="code -w"` style commands keep their flags.
    const [cmd, ...cmdArgs] = editorCmd.split(" ").filter(Boolean);
    // Resume exactly once (a double start leaks a resize listener).
    let resumed = false;
    const resume = (ok: boolean) => {
      if (resumed) return;
      resumed = true;
      void Bun.file(tmpFile)
        .unlink()
        .catch(() => {
          /* best effort */
        });
      t.start();
      t.requestRender(true);
      done(ok);
    };
    void (async () => {
      try {
        await Bun.write(tmpFile, `${content}\n`);
        const child = Bun.spawn([cmd!, ...cmdArgs, tmpFile], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        await child.exited;
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
  // Resolve the target: explicit arg (canonical or alias) or the select chooser.
  // Returns undefined when the user cancels the chooser or passes an unknown id.
  const resolveTarget = async (
    args: string,
    ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined>; notify(message: string, type?: "info" | "warning" | "error"): void } },
  ): Promise<TargetId | undefined> => {
    const trimmed = (args ?? "").trim();
    if (trimmed) {
      const target = normalizeTarget(trimmed);
      if (!target) {
        ctx.ui.notify(`Unknown view target: ${trimmed}. Try: ${TARGETS.map((t) => t.id).join(", ")}`, "error");
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
    ctx: {
      sessionManager: { getBranch: () => SessionEntry[] };
      ui: {
        editor(title: string, prefill?: string): Promise<string | undefined>;
        custom<T>(factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component): Promise<T>;
      };
    },
  ): Promise<void> => {
    const entries = ctx.sessionManager.getBranch();
    const meta = TARGETS.find((t) => t.id === target)!;
    const content = buildViewText(target, entries);
    const editorCmd = externalEditorCommand();
    if (editorCmd && (await openInExternalEditor(ctx, editorCmd, content))) return;
    await ctx.ui.editor(meta.title, content);
  };

  pi.registerCommand("view", {
    description: "View chatlog, thinking, latest-agent, or latest-user text (external editor, else in-app)",
    getArgumentCompletions: (prefix: string) =>
      TARGETS.map((t) => ({ value: t.id, label: t.id, description: t.label })).filter((item) =>
        item.value.startsWith(prefix.trim()),
      ),
    handler: async (args, ctx) => {
      const target = await resolveTarget(args, ctx);
      if (!target) return;
      await openView(target, ctx);
    },
  });
};

export default extension;

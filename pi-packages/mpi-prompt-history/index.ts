// +----------------------------------------------------------------------+
// |  mpi-prompt-history                                                  |
// |  /prompt-history browser  +  history.jsonl / session_index.jsonl     |
// |  production (record, backfill, index, system-prompt pointer).        |
// +----------------------------------------------------------------------+
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runPromptHistoryConfig } from "./config-ui.js";
import {
  appendHistoryEntry,
  buildPromptHistoryPrompt,
  loadGlobalPromptItems,
  ensurePromptHistoryState,
  promptHistoryPaths,
  readHistoryMaxBytes,
  resolveAgentDir,
} from "./history-store.js";
import { createPromptHistoryBrowserComponent } from "./prompt-history-browser.js";

/**
 * Roots already ensured in this process. Module state is shared across every
 * session in the host process (verified: one module instance serves all tabs),
 * so the expensive scan runs at most once per sessions root per process.
 */
const ensuredRoots = new Set<string>();

/**
 * True only for a MixCode tab session in the host process.
 *
 * - MIXCODE=1 excludes pure `pi`, which loads these packages too.
 * - MIXCODE_PID is set once by the mpi host; a child process that merely
 *   inherited the env sees a different own pid.
 * - mode "tui" excludes in-process subagent sessions, which are created without
 *   a mode and therefore run as "print". Their input events also report
 *   source "interactive", so the source filter alone cannot exclude them.
 */
function isMixCodeTabSession(ctx: ExtensionContext): boolean {
  const flag = process.env.MIXCODE?.trim().toLowerCase();
  if (!flag || flag === "0" || flag === "false" || flag === "off") return false;
  if (process.env.MIXCODE_PID?.trim() !== String(process.pid)) return false;
  return ctx.mode === "tui";
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prompt-history", {
    description: "Browse current session's prompt history; config edits the package config",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        {
          value: "config",
          label: "config",
          description: "Edit <agentDir>/mpi-prompt-history.json (history.jsonl size budget)",
        },
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (args.trim().split(/\s+/)[0]?.toLowerCase() === "config") {
        await runPromptHistoryConfig({ ctx, agentDir: resolveAgentDir() });
        return;
      }
      // Extract user messages from session entries
      const entries = ctx.sessionManager.getEntries();
      const userMessages: Array<{ text: string; timestamp?: string }> = [];

      for (const entry of entries) {
        if (entry.type === "message" && entry.message?.role === "user") {
          const msg = entry.message;
          const content = msg.content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
          }
          if (text.length > 0) {
            userMessages.push({
              text,
              timestamp: entry.timestamp,
            });
          }
        }
      }

      // An empty session still opens: Ctrl+G reaches the global history from here.
      const { historyFile } = promptHistoryPaths(resolveAgentDir());
      const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) =>
        createPromptHistoryBrowserComponent({
          tui,
          theme,
          items: userMessages,
          done,
          loadGlobalItems: () => loadGlobalPromptItems(historyFile),
        }),
      );
      if (selected) {
        ctx.ui.setEditorText(selected);
      }
    },
  });

  // Backfill + index rebuild scan every session file under the root, so they run
  // detached from session startup and at most once per root per process.
  pi.on("session_start", (_event, ctx) => {
    if (!isMixCodeTabSession(ctx)) return;
    const sessionsRoot = ctx.sessionManager.getSessionDir();
    // Claim the root before awaiting: tabs start concurrently, and two scans of
    // the same root would duplicate the work.
    if (ensuredRoots.has(sessionsRoot)) return;
    ensuredRoots.add(sessionsRoot);
    // ensurePromptHistoryState reports failures as warnings rather than rejecting.
    void ensurePromptHistoryState({ agentDir: resolveAgentDir(), sessionsRoot }).then(
      ({ warnings }) => {
        if (warnings.length > 0) {
          ctx.ui.notify(`History warning: ${warnings.join("; ")}`, "warning");
        }
      },
    );
  });

  // Record submitted prompts. "interactive" excludes extension-injected messages
  // (sendUserMessage), matching what the editor recorded before.
  pi.on("input", (event, ctx) => {
    if (!isMixCodeTabSession(ctx) || event.source !== "interactive") return;
    const paths = promptHistoryPaths(resolveAgentDir());
    void readHistoryMaxBytes(paths.configFile)
      .then((maxBytes) =>
        appendHistoryEntry(
          paths.historyFile,
          { sessionId: ctx.sessionManager.getSessionId(), text: event.text },
          maxBytes,
        ),
      )
      .catch((error: unknown) => {
        ctx.ui.notify(`History warning: ${errorMessage(error)}`, "warning");
      });
  });

  // Point the agent at the two files. Paths only — no history content is injected.
  pi.on("before_agent_start", (event, ctx) => {
    if (!isMixCodeTabSession(ctx)) return;
    const paths = promptHistoryPaths(resolveAgentDir());
    const block = buildPromptHistoryPrompt(paths);
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

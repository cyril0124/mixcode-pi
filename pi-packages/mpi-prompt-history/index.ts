// +----------------------------------------------------------------------+
// |  mpi-prompt-history                                                  |
// |  /prompt-history browser  +  history.jsonl / session_index.jsonl     |
// |  production (record, backfill, index, system-prompt pointer).        |
// +----------------------------------------------------------------------+
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { runPromptHistoryConfig } from "./config-ui.js";
import {
  appendHistoryEntry,
  buildPromptHistoryPrompt,
  ensurePromptHistoryState,
  loadGlobalPromptItems,
  loadWorkdirPromptItems,
  promptHistoryPaths,
  readHistoryMaxBytes,
  resolveAgentDir,
  upsertSessionIndexRecord,
} from "./history-store.js";
import { createPromptHistoryBrowserComponent } from "./prompt-history-browser.js";

/**
 * Roots already ensured in this process. Module state is shared across every
 * session in the host process (verified: one module instance serves all tabs),
 * so the startup backfill and index rebuild run at most once per sessions root
 * per process.
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
    description:
      "Browse session, workdir, and global prompt history; config edits the package config",
    ...({ argumentHint: "[config]" } as Record<string, unknown>),
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

      // An empty session still opens: Ctrl+G reaches workdir and global history from here.
      const paths = promptHistoryPaths(resolveAgentDir());
      const selected = await ctx.ui.custom<string | null>(
        (tui, theme, _keybindings, done) =>
          createPromptHistoryBrowserComponent({
            tui,
            theme,
            items: userMessages,
            done,
            copy: (text) => {
              void copyToClipboard(text).then(
                () => ctx.ui.notify("Copied to clipboard", "info"),
                (error: unknown) => ctx.ui.notify(`Copy failed: ${errorMessage(error)}`, "warning"),
              );
            },
            workdir: ctx.sessionManager.getCwd(),
            loadWorkdirItems: () =>
              loadWorkdirPromptItems({
                historyFile: paths.historyFile,
                sessionIndexFile: paths.sessionIndexFile,
                cwd: ctx.sessionManager.getCwd(),
              }),
            loadGlobalItems: () => loadGlobalPromptItems(paths.historyFile),
          }),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "78%", maxHeight: "80%", margin: 1 },
        },
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
    const agentDir = resolveAgentDir();
    const sessionsRoot = ctx.sessionManager.getSessionDir();
    const paths = promptHistoryPaths(agentDir);
    const shouldEnsureRoot = !ensuredRoots.has(sessionsRoot);
    if (shouldEnsureRoot) ensuredRoots.add(sessionsRoot);

    void (async () => {
      if (shouldEnsureRoot) {
        const { warnings } = await ensurePromptHistoryState({ agentDir, sessionsRoot });
        if (warnings.length > 0) {
          ctx.ui.notify(`Error: History warning: ${warnings.join("; ")}`, "warning");
        }
      }
      await upsertSessionIndexRecord(paths.sessionIndexFile, {
        id: ctx.sessionManager.getSessionId(),
        title: ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId(),
        updated_at: new Date().toISOString(),
        path: ctx.sessionManager.getSessionFile() ?? "",
        cwd: ctx.sessionManager.getCwd(),
      });
    })().catch((error: unknown) => {
      ctx.ui.notify(`Error: History warning: ${errorMessage(error)}`, "warning");
    });
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
    // Keep this contribution composable and recorded alongside other instructions.
    event.systemPromptOptions.sections["mpi-prompt-history"] = buildPromptHistoryPrompt(paths);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

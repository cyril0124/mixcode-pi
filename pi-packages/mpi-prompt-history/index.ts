import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getDefaultSessionDirPath } from "@earendil-works/pi-coding-agent";
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
 * Shared startup scans, one per sessions root per process. Tabs using the same
 * root must join its pending scan, not treat an in-flight rebuild as complete.
 */
const ensuredRoots = new Map<string, ReturnType<typeof ensurePromptHistoryState>>();

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
  let historyReady = Promise.resolve();
  let sessionGeneration = 0;

  // Detached writes may finish after shutdown, but their UI context is retired.
  pi.on("session_shutdown", () => {
    sessionGeneration++;
  });

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
            loadWorkdirItems: async () => {
              // Do not cache an incomplete snapshot while startup is rebuilding.
              await historyReady;
              return loadWorkdirPromptItems({
                historyFile: paths.historyFile,
                sessionIndexFile: paths.sessionIndexFile,
                cwd: ctx.sessionManager.getCwd(),
              });
            },
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
    const generation = ++sessionGeneration;
    if (!isMixCodeTabSession(ctx)) return;
    const agentDir = resolveAgentDir();
    // Changing workdir can retain the session's original file directory. Scan
    // the current workdir's Pi directory too, while supporting custom locations.
    const roots = new Set([
      ctx.sessionManager.getSessionDir(),
      getDefaultSessionDirPath(ctx.sessionManager.getCwd(), agentDir),
    ]);
    const paths = promptHistoryPaths(agentDir);
    // Snapshot identity before I/O: ctx getters reject after session replacement.
    const record = {
      id: ctx.sessionManager.getSessionId(),
      title: ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId(),
      updated_at: new Date().toISOString(),
      path: ctx.sessionManager.getSessionFile() ?? "",
      cwd: ctx.sessionManager.getCwd(),
    };

    historyReady = (async () => {
      for (const sessionsRoot of roots) {
        let ensureRoot = ensuredRoots.get(sessionsRoot);
        if (!ensureRoot) {
          // A shared scan must not retain the UI context of its first waiter.
          ensureRoot = ensurePromptHistoryState({ agentDir, sessionsRoot });
          ensuredRoots.set(sessionsRoot, ensureRoot);
        }
        const { warnings } = await ensureRoot;
        if (warnings.length > 0 && generation === sessionGeneration) {
          ctx.ui.notify(`Error: History warning: ${warnings.join("; ")}`, "warning");
        }
      }
      await upsertSessionIndexRecord(paths.sessionIndexFile, record);
    })().catch((error: unknown) => {
      if (generation === sessionGeneration) {
        ctx.ui.notify(`Error: History warning: ${errorMessage(error)}`, "warning");
      }
    });
  });

  // Interactive input excludes messages injected by extensions via sendUserMessage.
  pi.on("input", (event, ctx) => {
    if (!isMixCodeTabSession(ctx) || event.source !== "interactive") return;
    const paths = promptHistoryPaths(resolveAgentDir());
    const generation = sessionGeneration;
    const entry = { sessionId: ctx.sessionManager.getSessionId(), text: event.text };
    void readHistoryMaxBytes(paths.configFile)
      .then((maxBytes) => appendHistoryEntry(paths.historyFile, entry, maxBytes))
      .catch((error: unknown) => {
        if (generation === sessionGeneration) {
          ctx.ui.notify(`History warning: ${errorMessage(error)}`, "warning");
        }
      });
  });

  // Expose history file paths without injecting their contents.
  pi.on("before_agent_start", (event, ctx) => {
    if (!isMixCodeTabSession(ctx)) return;
    const paths = promptHistoryPaths(resolveAgentDir());
    // Named sections compose with other extensions and persist in the transcript.
    event.systemPromptOptions.sections["mpi-prompt-history"] = buildPromptHistoryPrompt(paths);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

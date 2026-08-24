/**
 * mpi-bash - bash execution policy for MixCode.
 *
 * Assembles the pieces: `exec.ts` runs commands, `widget.ts` shows the ones
 * still running, `log-view.ts` reads their logs back.
 */

import * as fs from "node:fs";
import {
  createBashToolDefinition,
  type ExtensionContext,
  type ExtensionFactory,
  SettingsManager,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  appendBashTimeoutNote,
  BASH_DEFAULT_TIMEOUT_SECONDS,
  createDetachingBashOperations,
  type DetachedStart,
  formatCompletionNotice,
  pruneOldLogs,
  resolveForegroundSeconds,
} from "./exec.js";
import { LogView, openInExternalEditor, type SuspendableTui } from "./log-view.js";
import {
  BackgroundStatus,
  type FinishedRun,
  formatRunChoice,
  readLogForView,
} from "./widget.js";

export * from "./exec.js";
export * from "./widget.js";

/** Custom message type carrying a detached command's exit code. */
export const BASH_DETACHED_EXIT_CUSTOM_TYPE = "bash-detached-exit";

/** How often the pager re-reads a still-running command's log. */
const FOLLOW_REFRESH_MS = 1000;

/**
 * Re-read `logPath` only when it changed since `stamp` (size and mtime).
 * Returns the new text with its stamp, or undefined when nothing moved - a
 * quiet command would otherwise cost a full read and rewrap every second.
 */
async function reloadLogIfChanged(
  logPath: string,
  stamp: string,
): Promise<{ text: string; stamp: string } | undefined> {
  const stats = await fs.promises.stat(logPath);
  const current = `${stats.size}:${stats.mtimeMs}`;
  if (current === stamp) return undefined;
  return { text: await readLogForView(logPath), stamp: current };
}

const bashExtension: ExtensionFactory = (pi) => {
  const backgroundStatus = new BackgroundStatus();

  pi.on("tool_call", (event: ToolCallEvent) => {
    if (event.toolName !== "bash") return;
    event.input.timeout ??= BASH_DEFAULT_TIMEOUT_SECONDS;
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: appendBashTimeoutNote(event.systemPrompt),
  }));

  pi.registerCommand("bash-logs", {
    description: "Read the full log of a command bash sent to the background",
    handler: async (_args, ctx) => {
      const runs = backgroundStatus.list();
      if (runs.length === 0) {
        ctx.ui.notify("No command has been sent to the background in this session.", "info");
        return;
      }
      // Choices must stay unique: two identical commands would otherwise map to
      // the same picker row.
      const byChoice = new Map<string, DetachedStart | FinishedRun>(
        runs.map((run) => [formatRunChoice(run), run]),
      );
      const choice = await ctx.ui.select("Background command logs", [...byChoice.keys()]);
      const run = choice === undefined ? undefined : byChoice.get(choice);
      if (!run) return;
      let text: string;
      try {
        text = await readLogForView(run.logPath);
      } catch (error) {
        ctx.ui.notify(`Cannot read ${run.logPath}: ${(error as Error).message}`, "error");
        return;
      }
      // A read-only pager, not ctx.ui.editor: the log is a file, so the overlay
      // must not offer typing or submitting.
      let follow: ReturnType<typeof setInterval> | undefined;
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          const closeView = () => {
            if (follow) clearInterval(follow);
            follow = undefined;
            done(undefined);
          };
          const view = new LogView(
            theme,
            run.logPath,
            text,
            () => tui.requestRender(),
            closeView,
            () => Math.floor(tui.terminal.rows * 0.8) - 4,
            () => {
              // The editor takes over the tty, so the pager closes first and the
              // user lands back in the session when the editor exits.
              closeView();
              void openInExternalEditor(tui as unknown as SuspendableTui, run.logPath).then(
                (error) => {
                  if (error) ctx.ui.notify(error, "error");
                },
              );
            },
          );
          // A finished run's log never changes; only a live one is re-read.
          if (!("endedAt" in run)) {
            let seen = "";
            follow = setInterval(() => {
              void reloadLogIfChanged(run.logPath, seen).then(
                (result) => {
                  if (!result) return;
                  seen = result.stamp;
                  view.setText(result.text);
                },
                () => {
                  // The log went away mid-run (user deleted it): keep showing
                  // what was already read instead of tearing the overlay down.
                },
              );
            }, FOLLOW_REFRESH_MS);
            follow.unref?.();
          }
          return view;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "86%", maxHeight: "80%", margin: 1 },
        },
      );
      if (follow) clearInterval(follow);
    },
  });

  // The bash tool must be rebuilt per session: cwd and shell settings are
  // session-scoped, and pi lets a registered tool override the builtin by name.
  pi.on("session_shutdown", () => backgroundStatus.dispose());

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    backgroundStatus.bind(ctx);
    void pruneOldLogs();
    const settings = SettingsManager.create(ctx.cwd);
    pi.registerTool(
      createBashToolDefinition(ctx.cwd, {
        commandPrefix: settings.getShellCommandPrefix(),
        shellPath: settings.getShellPath(),
        operations: createDetachingBashOperations({
          shellPath: settings.getShellPath(),
          foregroundSeconds: resolveForegroundSeconds(),
          onDetached: (start) => backgroundStatus.add(start),
          onDetachedExit: (run) => {
            backgroundStatus.finish(run);
            try {
              // Not a turn trigger: the result joins the context and is read on
              // the next model call, so a finished command never wakes an idle
              // agent.
              pi.sendMessage(
                {
                  customType: BASH_DETACHED_EXIT_CUSTOM_TYPE,
                  content: formatCompletionNotice(run),
                  display: true,
                  details: { exitCode: run.exitCode, logPath: run.logPath },
                },
                { triggerTurn: false },
              );
            } catch {
              // The session was replaced or closed while the command ran, so the
              // notice has nowhere to land. The log file keeps the output.
            }
          },
        }),
      }),
    );
  });
};

export default bashExtension;

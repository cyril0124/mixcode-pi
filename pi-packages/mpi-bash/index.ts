/**
 * mpi-bash - bash execution policy for MixCode.
 *
 * Assembles the pieces: `exec.ts` runs commands, `widget.ts` shows the ones
 * still running, `bash-logs.ts` reads their logs back.
 */

import {
  createBashToolDefinition,
  type ExtensionContext,
  type ExtensionFactory,
  SettingsManager,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { BashLogs } from "./bash-logs.js";
import {
  appendBashTimeoutNote,
  BASH_DEFAULT_TIMEOUT_SECONDS,
  createDetachingBashOperations,
  formatCompletionNotice,
  killTree,
  pruneOldLogs,
  resolveForegroundSeconds,
} from "./exec.js";
import { resolveStallSeconds, StallMonitor, stallCheckIntervalMs } from "./heartbeat.js";
import { openInExternalEditor, type SuspendableTui } from "./log-view.js";
import {
  BackgroundStatus,
  type DetachedExitDetails,
  hasEnded,
  readLogForView,
  renderCompletionMessage,
  renderStallMessage,
  type StallDetails,
} from "./widget.js";

export * from "./exec.js";
export * from "./heartbeat.js";
export * from "./widget.js";

/** Custom message type carrying a detached command's exit code. */
export const BASH_DETACHED_EXIT_CUSTOM_TYPE = "bash-detached-exit";

/** Custom message type warning that a background command has gone silent. */
export const BASH_STALL_CUSTOM_TYPE = "bash-detached-stall";

const bashExtension: ExtensionFactory = (pi) => {
  const backgroundStatus = new BackgroundStatus();

  const stallMs = resolveStallSeconds() * 1000;
  // One timer per live session, paired with backgroundStatus.bind/dispose. The
  // factory runs again on every services build (/reload, /workdir, each tab
  // restored at boot), so a factory-scoped timer would accumulate.
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  const stopStallTimer = () => {
    if (stallTimer) clearInterval(stallTimer);
    stallTimer = undefined;
  };
  const startStallTimer = () => {
    if (stallMs <= 0 || stallTimer) return;
    const stalls = new StallMonitor(stallMs);
    stallTimer = setInterval(() => {
      void stalls.check(backgroundStatus.running()).then(
        (report) => {
          if (!report) return;
          try {
            // followUp, not steer: a silent job is not urgent enough to cut
            // into a running turn, but it must wake an idle session so the
            // model can decide to wait or kill instead of blocking until the
            // timeout.
            pi.sendMessage<StallDetails[]>(
              {
                customType: BASH_STALL_CUSTOM_TYPE,
                content: report.content,
                display: true,
                details: report.jobs,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch {
            // The session was replaced or closed; the widget still shows the job.
          }
        },
        () => {
          // A check that failed on the filesystem skips this tick and the next
          // one retries. An unhandled rejection would take down the process.
        },
      );
    }, stallCheckIntervalMs(stallMs));
    // Unref so a session waiting on nothing else can still exit.
    stallTimer.unref?.();
  };

  pi.registerMessageRenderer<DetachedExitDetails>(
    BASH_DETACHED_EXIT_CUSTOM_TYPE,
    (message, _options, theme) => {
      const details = message.details;
      if (!details) return undefined;
      return {
        render: (width: number) => renderCompletionMessage(details, theme, width),
        invalidate: () => {},
      };
    },
  );

  pi.registerMessageRenderer<StallDetails[]>(BASH_STALL_CUSTOM_TYPE, (message, _options, theme) => {
    const jobs = message.details;
    if (!jobs) return undefined;
    return {
      render: (width: number) => renderStallMessage(jobs, theme, width),
      invalidate: () => {},
    };
  });

  pi.on("tool_call", (event: ToolCallEvent) => {
    if (event.toolName !== "bash") return;
    event.input.timeout ??= BASH_DEFAULT_TIMEOUT_SECONDS;
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: appendBashTimeoutNote(event.systemPrompt),
  }));

  pi.registerCommand("bash-logs", {
    description: "Inspect background bash jobs and their logs",
    handler: async (_args, ctx) => {
      const runs = backgroundStatus.list();
      if (runs.length === 0) {
        ctx.ui.notify("No command has been sent to the background in this session.", "info");
        return;
      }
      let initialText = "";
      try {
        initialText = await readLogForView(runs[0]!.logPath);
      } catch (error) {
        initialText = `Cannot read ${runs[0]!.logPath}: ${(error as Error).message}`;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new BashLogs({
            theme,
            list: () => backgroundStatus.list(),
            requestRender: () => tui.requestRender(),
            done: () => done(undefined),
            terminalRows: () => tui.terminal.rows,
            initialText,
            openExternal: (logPath) => {
              void openInExternalEditor(tui as unknown as SuspendableTui, logPath).then((error) => {
                if (error) ctx.ui.notify(error, "error");
              });
            },
            kill: (run) => {
              if (hasEnded(run) || !backgroundStatus.running().some((live) => live.id === run.id)) {
                ctx.ui.notify(`Job #${run.id} has already finished.`, "info");
                return;
              }
              killTree(run.id);
              ctx.ui.notify(`Killed job #${run.id} and its children.`, "info");
            },
          }),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "78%", maxHeight: "80%", margin: 1 },
        },
      );
    },
  });

  // The bash tool must be rebuilt per session: cwd and shell settings are
  // session-scoped, and pi lets a registered tool override the builtin by name.
  pi.on("session_shutdown", () => {
    backgroundStatus.dispose();
    stopStallTimer();
  });

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    backgroundStatus.bind(ctx);
    startStallTimer();
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
              // Starts a turn so the model can act on the exit code.
              pi.sendMessage(
                {
                  customType: BASH_DETACHED_EXIT_CUSTOM_TYPE,
                  content: formatCompletionNotice(run),
                  display: true,
                  details: {
                    command: run.command,
                    exitCode: run.exitCode,
                    timedOut: run.timedOut,
                    tail: run.tail,
                    lineCount: run.lineCount,
                    elapsedMs: run.elapsedMs,
                    logPath: run.logPath,
                    logError: run.logError,
                  } satisfies DetachedExitDetails,
                },
                { triggerTurn: true },
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

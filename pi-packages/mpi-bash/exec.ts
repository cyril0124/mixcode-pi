import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

/**
 * Command execution: the foreground window, the handover to the background,
 * the log file a detached command writes, and the notices both produce.
 */

/**
 * Injected when the model omits `timeout`. It bounds the command's total life,
 * including the part that runs in the background after detaching.
 */
export const BASH_DEFAULT_TIMEOUT_SECONDS = 300;

/** Foreground blocking window before a command is handed to the background. */
export const DEFAULT_FOREGROUND_SECONDS = 30;

/** Output kept in memory after detaching, to quote in the completion notice. */
const NOTICE_TAIL_BYTES = 2000;

/**
 * Output held in memory before detaching, replayed into the log at that point.
 * A command that floods stdout must not grow the host process without bound,
 * so past this the oldest bytes are dropped and the log records the gap.
 */
const REPLAY_BUFFER_BYTES = 4 * 1024 * 1024;

/** Written into the log in place of output dropped by the replay cap. */
const REPLAY_DROPPED_MARKER = "[mpi-bash] earlier output dropped\n";

/** Idle window after `exit` before stdio is considered drained (pi's grace). */
const EXIT_STDIO_GRACE_MS = 100;

const SYSTEM_PROMPT_NOTE = `Bash execution policy: the bash tool applies a default timeout of ${BASH_DEFAULT_TIMEOUT_SECONDS} seconds when the timeout argument is omitted, and that timeout bounds the command's total life. A command still running after a shorter foreground window is moved to the background instead of being killed: the tool result then reports its pid and a log file. Follow it with \`tail\`, stop it with \`kill\`, and never poll in a loop waiting for it - its exit code is delivered to you automatically once it finishes.`;

export function appendBashTimeoutNote(systemPrompt: string): string {
  if (systemPrompt.includes(SYSTEM_PROMPT_NOTE)) return systemPrompt;
  return `${systemPrompt}\n\n${SYSTEM_PROMPT_NOTE}`;
}

/**
 * Foreground window in seconds. `0` disables detaching, which restores pi's
 * plain behavior: block until the command ends or its timeout kills it.
 *
 * Throws on a malformed value instead of silently using the default.
 */
export function resolveForegroundSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MPI_BASH_FOREGROUND_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_FOREGROUND_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `MPI_BASH_FOREGROUND_SECONDS must be a non-negative number of seconds, got: ${raw}`,
    );
  }
  return value;
}

export function formatDetachNotice(options: {
  seconds: number;
  pid: number | undefined;
  logPath: string;
}): string {
  return (
    `\n[mpi-bash] Still running after ${options.seconds}s - detached to the background (pid ${options.pid ?? "unknown"}).\n` +
    `Its complete output, including everything shown above, is being written to ${options.logPath}.\n` +
    `Follow it with \`tail -n 50 ${options.logPath}\`, stop it with \`kill -- -${options.pid ?? ""}\` (the whole process group).\n` +
    `Its exit code will be delivered to you automatically; do not poll for it - continue with other work.\n`
  );
}

export function formatCompletionNotice(run: {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  logPath: string;
  logError?: string;
  tail: string;
}): string {
  const outcome = run.timedOut
    ? "was killed after reaching its timeout"
    : `exited with code ${run.exitCode ?? "unknown"}`;
  const log = run.logError
    ? `\nIts output could not be written to ${run.logPath}: ${run.logError}`
    : `\nComplete output (foreground and background): ${run.logPath} - read that file when the tail below is not enough.`;
  // Only claim a truncated tail when the buffer actually hit its cap.
  const label = Buffer.byteLength(run.tail) >= NOTICE_TAIL_BYTES ? "Last bytes" : "Output";
  const tail = run.tail.trim() ? `\n${label}:\n${run.tail.trim()}` : "\nNo output.";
  return `[mpi-bash] The detached command ${outcome}.\nCommand: ${run.command}${log}${tail}`;
}

/** Node's timer ceiling; pi rejects longer timeouts rather than truncating them. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Timeout validation mirroring pi's bash tool, which this execution replaces. */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  }
  return timeoutMs;
}

/** SIGKILL the child's process group, falling back to the child alone. */
function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH on the group (already gone, or never a group leader): try the pid.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ESRCH: the process is already dead.
    }
  }
}

/**
 * Resolve when the child has exited and its stdio has fallen idle.
 *
 * A detached descendant can hold the pipes open past `exit`, so resolving on
 * `exit` alone truncates late output while waiting for `close` alone can hang.
 * The grace timer is re-armed by every chunk, mirroring pi's own bash wait.
 */
function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exitCode: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    child.stdout?.on("data", () => {
      if (!settled && exitCode !== null) arm();
    });
    child.stderr?.on("data", () => {
      if (!settled && exitCode !== null) arm();
    });
    child.once("exit", (code) => {
      exitCode = code;
      arm();
    });
    child.once("close", (code) => finalize(code));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
  });
}

/** Serial number for log file names, unique within this process. */
let logSequence = 0;
function nextLogSequence(): number {
  logSequence += 1;
  return logSequence;
}

/** Log files older than this are removed when a session starts. */
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete background logs left by earlier runs. Detached logs are kept on
 * purpose, so nothing else ever removes them; without this they accumulate in
 * the temp directory for as long as the machine lives.
 *
 * Best effort: a log that cannot be read or removed is skipped.
 */
export async function pruneOldLogs(
  now = Date.now(),
  dir = os.tmpdir(),
  retentionMs = LOG_RETENTION_MS,
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    // Unreadable temp directory: nothing to prune, and bash still works.
    return 0;
  }
  for (const entry of entries) {
    if (!/^mpi-bash-.*\.log$/.test(entry)) continue;
    const file = path.join(dir, entry);
    try {
      const stats = await fs.promises.stat(file);
      if (now - stats.mtimeMs < retentionMs) continue;
      await fs.promises.rm(file, { force: true });
      removed += 1;
    } catch {
      // Raced with another instance, or not ours to delete; leave it alone.
    }
  }
  return removed;
}

/** Foreground children, killed if the host exits while they are still running. */
const foregroundChildren = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const pid of foregroundChildren) killTree(pid);
  });
}

export interface DetachedRun {
  /** Matches the `id` reported by `onDetached`; the child pid. */
  id: number;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  logPath: string;
  /** Set when the background log could not be written; reported to the model. */
  logError?: string;
  tail: string;
  /** Total output lines, including a last line that has no trailing newline. */
  lineCount: number;
}

export interface DetachedStart {
  id: number;
  command: string;
  startedAt: number;
  logPath: string;
}

/**
 * Bash execution that hands long commands to the background.
 *
 * Contract with pi's bash tool (`BashOperations`): stream output through
 * `onData`, throw `aborted` when the abort signal fires, throw `timeout:<secs>`
 * when the command is killed by its timeout, otherwise resolve with the exit
 * code. Detaching resolves with exit code 0 after appending a handle notice, so
 * the turn continues while the command keeps running.
 */
export function createDetachingBashOperations(options: {
  shellPath: string | undefined;
  foregroundSeconds: number;
  onDetached?: (start: DetachedStart) => void;
  onDetachedExit: (run: DetachedRun) => void;
}): BashOperations {
  installExitHook();
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error("aborted");
      try {
        await fs.promises.access(cwd, fs.constants.F_OK);
      } catch {
        // ENOENT/EACCES: pi reports the directory, not the raw spawn failure.
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      // Elapsed time is reported from here, not from the detach point, so the
      // widget shows the command's real age instead of hiding the foreground
      // window (60s by default).
      const startedAt = Date.now();
      const shellConfig = getShellConfig(options.shellPath);
      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const child = spawn(
        shellConfig.shell,
        commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
        {
          cwd,
          detached: process.platform !== "win32",
          env,
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => {
          // EPIPE: the shell exited before consuming the command.
        });
        child.stdin?.end(command);
      }
      if (child.pid) foregroundChildren.add(child.pid);

      let detached = false;
      let timedOut = false;
      let logError: string | undefined;
      let tail = Buffer.alloc(0);
      let lineCount = 0;
      let danglingLine = false;
      // Held in memory until the command detaches, then flushed to the log so
      // the file is still the complete record. A command that finishes in the
      // foreground never touches the disk: its output is in the tool result.
      let buffered: Buffer[] | undefined = [];
      let bufferedBytes = 0;
      let bufferedDropped = false;
      let logStream: fs.WriteStream | undefined;

      const handleChunk = (data: Buffer) => {
        if (buffered) {
          buffered.push(data);
          bufferedBytes += data.length;
          while (bufferedBytes > REPLAY_BUFFER_BYTES && buffered.length > 1) {
            bufferedBytes -= buffered.shift()?.length ?? 0;
            bufferedDropped = true;
          }
        }
        logStream?.write(data);
        tail = Buffer.concat([tail, data]).subarray(-NOTICE_TAIL_BYTES);
        for (const byte of data) {
          if (byte === 0x0a) {
            lineCount++;
            danglingLine = false;
          } else {
            danglingLine = true;
          }
        }
        // Past detach the tool result is finalized, so it stops receiving output.
        if (!detached) onData(data);
      };
      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);

      const onAbort = () => {
        if (child.pid) killTree(child.pid);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      const timeoutTimer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              if (child.pid) killTree(child.pid);
            }, timeoutMs);

      const exited = waitForExit(child).finally(() => {
        if (child.pid) foregroundChildren.delete(child.pid);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
      });

      const exitedTagged = exited.then(() => "exited" as const);
      let detachTimer: ReturnType<typeof setTimeout> | undefined;
      let outcome: "exited" | "detach";
      try {
        outcome =
          options.foregroundSeconds > 0
            ? await Promise.race([
                exitedTagged,
                new Promise<"detach">((resolve) => {
                  detachTimer = setTimeout(() => resolve("detach"), options.foregroundSeconds * 1000);
                }),
              ])
            : await exitedTagged;
      } finally {
        // A wait that rejects (stdio failure) must not strand the window timer.
        if (detachTimer) clearTimeout(detachTimer);
      }

      if (outcome === "exited") {
        const exitCode = await exited;
        buffered = undefined;
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      }
      detached = true;

      // The name carries a sequence number: pids are reused, and a new command
      // must never truncate a finished run's log that `/bash-jobs` still lists.
      const logPath = path.join(
        os.tmpdir(),
        `mpi-bash-${child.pid ?? "nopid"}-${nextLogSequence()}.log`,
      );
      try {
        // Written synchronously: the detach notice hands out this path, and a
        // reader opening it immediately must not race the stream's async open.
        const replay = Buffer.concat(buffered ?? []);
        fs.writeFileSync(
          logPath,
          bufferedDropped ? Buffer.concat([Buffer.from(REPLAY_DROPPED_MARKER), replay]) : replay,
        );
        logStream = fs.createWriteStream(logPath, { flags: "a" });
        // An unhandled stream error would take down the host process; an
        // unwritable tmpdir must only cost the log, and it is reported in the
        // completion notice rather than swallowed.
        logStream.on("error", (error) => {
          logError = error.message;
          logStream = undefined;
        });
      } catch (error) {
        // Unwritable temp directory: the command keeps running without a log.
        logError = (error as Error).message;
      }
      buffered = undefined;

      if (child.pid) foregroundChildren.delete(child.pid);
      // Aborting the turn must not kill a command that already left the foreground.
      if (signal) signal.removeEventListener("abort", onAbort);
      child.unref();
      onData(Buffer.from(formatDetachNotice({ seconds: options.foregroundSeconds, pid: child.pid, logPath })));
      const runId = child.pid ?? Date.now();
      options.onDetached?.({ id: runId, command, startedAt, logPath });

      const reportExit = (exitCode: number | null) => {
        logStream?.end();
        options.onDetachedExit({
          id: runId,
          command,
          exitCode,
          timedOut,
          logPath,
          logError,
          tail: tail.toString("utf8"),
          lineCount: lineCount + (danglingLine ? 1 : 0),
        });
      };
      // Both settlements must report: a rejected wait (stdio failure after
      // detach) still ends the run, and dropping it would strand the status
      // entry and the notice.
      exited.then(reportExit, () => reportExit(null));

      return { exitCode: 0 };
    },
  };
}

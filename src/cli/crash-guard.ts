import * as fs from "node:fs";
import * as path from "node:path";
import { resolveMixcodeStateDir } from "../core/paths.js";

/** Stack when available, message otherwise; non-Error throws stringify. */
export function describeCrash(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Persist a fatal error to <stateDir>/crash.log. Once the TUI has entered the
 * alternate screen, stderr is invisible and repainted over, while live TUI
 * handles keep the event loop (and a half-initialized app) running — without
 * this file such crashes leave no recoverable trace.
 */
export function appendCrashLog(message: string): void {
  const stateDir = resolveMixcodeStateDir();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, "crash.log"),
      `[${new Date().toISOString()}] ${message}\n\n`,
    );
  } catch {
    // Best-effort crash log (EACCES/EROFS/full disk): stderr already carries the trace.
  }
}

/**
 * Install process-level handlers for faults that escape the TUI event loop —
 * extension callbacks, timers, stream events, detached promises. `main().catch`
 * only covers the awaited startup chain. The Bun default for such a fault kills
 * the process with no teardown and no trace beyond terminal scrollback the TUI
 * frame has already painted over, so the stack is unrecoverable once the window
 * is closed; the crash log is the postmortem record. Teardown additionally
 * drops this instance's `instances/<hostname>/<pid>.{json,sock}` right away
 * instead of leaving it for the next startup's registry sweep.
 *
 * Contract: `teardown` owns stopping the TUI and process-lifetime cleanup. It
 * must be synchronous, idempotent, and callable at any point after
 * `tui.start()`, and runs before anything is written to stderr. Handlers are
 * prepended so they win over listeners registered by extensions or upstream Pi,
 * run at most once (a fault raised while unwinding is dropped rather than
 * re-entered), and always end in `process.exit(1)`.
 */
export function installCrashGuard(teardown: () => void): void {
  let crashing = false;
  const handle = (kind: string, error: unknown): void => {
    if (crashing) return;
    crashing = true;
    const message = `${kind}: ${describeCrash(error)}`;
    try {
      teardown();
    } catch {
      // Teardown of a half-broken TUI (renderer already disposed, closed tty):
      // the trace below still has to reach the user and the crash log.
    }
    // Straight to the real stderr: the console bridge would queue this into a
    // notice panel that a dying process never renders.
    process.stderr.write(`\nmpi crashed — ${message}\n`);
    appendCrashLog(message);
    process.exit(1);
  };
  process.prependListener("uncaughtException", (error) => handle("uncaughtException", error));
  process.prependListener("unhandledRejection", (reason) => handle("unhandledRejection", reason));
}

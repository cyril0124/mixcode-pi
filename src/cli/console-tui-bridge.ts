// Console → TUI bridge.
//
// Problem: the TUI owns the screen and paints frames via process.stdout.write.
// Extensions (e.g. pi-schedule-prompt) call console.log/warn/error, which write
// raw text to the same tty, corrupt the frame, and duplicate the tab bar. Pi
// deliberately skips its stdout takeover in interactive mode, so the host has to
// relocate console output onto the managed surface itself.
//
// This module overrides the console methods so their output is rendered through
// the TUI instead of leaking to the raw tty. Nothing is swallowed: messages are
// formatted (exactly like console, via node:util.format) with a
// `[console.<method>]:` prefix and handed to a late-bound sink. Before the TUI
// exists, messages queue; once wireConsoleSink runs, the backlog flushes in
// order. Disable by removing the installConsoleTuiBridge() call in main.ts.

import { format } from "node:util";

/** Console methods relocated to the TUI. console.trace/dir/etc. are left as-is. */
const BRIDGED_METHODS = ["log", "info", "debug", "warn", "error"] as const;
type BridgedMethod = (typeof BRIDGED_METHODS)[number];

/** Receives a fully formatted, prefixed line ready to display. */
export type ConsoleSink = (text: string) => void;

let sink: ConsoleSink | undefined;
// Backlog of lines produced before the TUI sink is wired (e.g. during extension
// loading). Flushed in arrival order by wireConsoleSink.
const pending: string[] = [];

/** Format console args the way console itself does, then tag with the method. */
function formatLine(method: BridgedMethod, args: unknown[]): string {
  return `[console.${method}]: ${format(...args)}`;
}

function emit(line: string): void {
  if (sink) sink(line);
  else pending.push(line);
}

/**
 * Override console.{log,info,debug,warn,error} to route through the TUI sink.
 * Call once, early in startup — before any extension can log — so nothing leaks
 * to the raw tty. Idempotent is not required; main.ts calls it exactly once.
 */
export function installConsoleTuiBridge(): void {
  for (const method of BRIDGED_METHODS) {
    console[method] = (...args: unknown[]) => emit(formatLine(method, args));
  }
}

/**
 * Register the display sink (the TUI overlay renderer) and flush any messages
 * that were queued before the TUI existed. Subsequent console calls go straight
 * to the sink.
 */
export function wireConsoleSink(fn: ConsoleSink): void {
  sink = fn;
  for (const line of pending.splice(0)) fn(line);
}

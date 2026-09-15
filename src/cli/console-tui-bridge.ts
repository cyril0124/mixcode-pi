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
//
// All tabs share one process and one history, so each record also stores the tab
// title reported by src/core/console-scope.ts at emit time; /console-history
// prints it between the timestamp and the line.

import { format } from "node:util";
import { currentConsoleTab } from "../core/console-scope.js";

/** Console methods relocated to the TUI. console.trace/dir/etc. are left as-is. */
const BRIDGED_METHODS = ["log", "info", "debug", "warn", "error"] as const;
const CONSOLE_HISTORY_LIMIT = 1_000;
type BridgedMethod = (typeof BRIDGED_METHODS)[number];

/** Receives a fully formatted, prefixed line ready to display. */
export type ConsoleSink = (text: string) => void;

let sink: ConsoleSink | undefined;
// Backlog of lines produced before the TUI sink is wired (e.g. during extension
// loading). Flushed in arrival order by wireConsoleSink.
const pending: string[] = [];
// Emit time backs the /console-history timestamp; the live sink line stays
// unprefixed.
interface ConsoleRecord {
  time: number;
  /** Tab whose work emitted the line; undefined for work outside any tab. */
  tab?: string;
  line: string;
}
const history: ConsoleRecord[] = [];

/**
 * Return a stable snapshot of console output captured during this process.
 * Each line reads `<YYYY-MM-DD HH:MM:SS> [<tab>] <line>`; the tab segment is
 * absent for lines emitted outside tab-owned work (startup, extension timers).
 */
export function getConsoleHistory(): string[] {
  return history.map(
    ({ time, tab, line }) => `${formatConsoleTime(time)} ${tab ? `[${tab}] ` : ""}${line}`,
  );
}

/** Local-time YYYY-MM-DD HH:MM:SS stamp, same shape as `formatCtlTime`. */
function formatConsoleTime(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Format console args the way console itself does, then tag with the method. */
function formatLine(method: BridgedMethod, args: unknown[]): string {
  return `[console.${method}]: ${format(...args)}`;
}

function emit(line: string): void {
  const tab = currentConsoleTab();
  history.push({ time: Date.now(), line, ...(tab ? { tab } : {}) });
  if (history.length > CONSOLE_HISTORY_LIMIT) history.shift();
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

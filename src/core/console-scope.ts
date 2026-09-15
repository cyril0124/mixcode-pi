import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tab label for the async work currently running. The console bridge
 * (src/cli/console-tui-bridge.ts) reads it when a line is emitted and stores it
 * with that line, which /console-history prints as the emitting tab.
 *
 * All tabs share one process and one console history. A label exists only
 * inside runWithConsoleTab; work started outside a tab (startup, extension
 * timers, Home actions) carries none.
 */
const storage = new AsyncLocalStorage<string>();

/** Run `fn` with `tabTitle` as the console label for every async task it starts. */
export function runWithConsoleTab<T>(tabTitle: string, fn: () => T): T {
  return storage.run(tabTitle, fn);
}

/** Title of the tab whose work runs here, or undefined when no tab-scoped work is running. */
export function currentConsoleTab(): string | undefined {
  return storage.getStore();
}

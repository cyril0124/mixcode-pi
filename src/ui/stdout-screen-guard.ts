/**
 * Host owns the TTY while the MixCode TUI is alive.
 *
 * Extensions sometimes write full-screen clears straight to process.stdout
 * (e.g. session_start polish). That bypasses pi-tui, flashes multi-tab restore,
 * and can leave blank holes in the differential renderer.
 *
 * Contract:
 * - Writes that go through the host Terminal facade set hostWriteDepth > 0 and
 *   may clear the screen.
 * - Direct process.stdout writes with full-screen clear CSI are stripped.
 */

import type { Terminal } from "@earendil-works/pi-tui";

/** Full-screen erase: CSI 2J (screen) / 3J (scrollback). */
const FULL_SCREEN_CLEAR_RE = /\x1b\[(?:2|3)J/g;
/** Cursor home; only stripped when the same chunk also had a full-screen clear. */
const CURSOR_HOME_RE = /\x1b\[H/g;

let hostWriteDepth = 0;
let originalWrite: typeof process.stdout.write | undefined;

function withHostStdoutWrite<T>(fn: () => T): T {
  hostWriteDepth += 1;
  try {
    return fn();
  } finally {
    hostWriteDepth -= 1;
  }
}

function stripUnauthorizedScreenClears(text: string): {
  text: string;
  stripped: boolean;
} {
  let stripped = false;
  let next = text.replace(FULL_SCREEN_CLEAR_RE, () => {
    stripped = true;
    return "";
  });
  // Common full-clear is "\x1b[2J\x1b[H". Host never hits this path with depth 0.
  if (stripped) {
    next = next.replace(CURSOR_HOME_RE, () => {
      stripped = true;
      return "";
    });
  }
  return { text: next, stripped };
}

export function installStdoutScreenGuard(): () => void {
  // Second installation is a no-op; the existing guard already owns stdout.
  if (originalWrite) return uninstallStdoutScreenGuard;
  originalWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean => {
    if (!originalWrite) return false;
    if (hostWriteDepth > 0) {
      return (originalWrite as (c: typeof chunk, e?: typeof encoding, f?: typeof cb) => boolean)(
        chunk,
        encoding,
        cb,
      );
    }
    const asString = chunkToString(chunk);
    if (asString === undefined) {
      return (originalWrite as (c: typeof chunk, e?: typeof encoding, f?: typeof cb) => boolean)(
        chunk,
        encoding,
        cb,
      );
    }
    const { text, stripped } = stripUnauthorizedScreenClears(asString);
    if (!stripped) {
      return (originalWrite as (c: typeof chunk, e?: typeof encoding, f?: typeof cb) => boolean)(
        chunk,
        encoding,
        cb,
      );
    }
    if (text.length === 0) {
      // Preserve write() callback semantics for empty filtered chunks.
      if (typeof encoding === "function") encoding();
      else if (typeof cb === "function") cb();
      return true;
    }
    return (originalWrite as (c: string, e?: typeof encoding, f?: typeof cb) => boolean)(
      text,
      encoding,
      cb,
    );
  }) as typeof process.stdout.write;

  return uninstallStdoutScreenGuard;
}

function uninstallStdoutScreenGuard(): void {
  // originalWrite is the single installed-state source of truth.
  if (!originalWrite) return;
  process.stdout.write = originalWrite;
  originalWrite = undefined;
  hostWriteDepth = 0;
}

function chunkToString(chunk: string | Uint8Array): string | undefined {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return undefined;
}

/**
 * Wrap a Terminal so every stdout-touching method runs under hostWriteDepth.
 * Required because pi-tui ProcessTerminal calls process.stdout.write from many
 * methods, not only write().
 */
export function withHostStdoutGuard(terminal: Terminal): Terminal {
  return {
    start: (onInput, onResize) => withHostStdoutWrite(() => terminal.start(onInput, onResize)),
    stop: () => withHostStdoutWrite(() => terminal.stop()),
    drainInput: (maxMs, idleMs) => withHostStdoutWrite(() => terminal.drainInput(maxMs, idleMs)),
    write: (data) => withHostStdoutWrite(() => terminal.write(data)),
    get columns() {
      return terminal.columns;
    },
    get rows() {
      return terminal.rows;
    },
    get kittyProtocolActive() {
      return terminal.kittyProtocolActive;
    },
    moveBy: (lines) => withHostStdoutWrite(() => terminal.moveBy(lines)),
    hideCursor: () => withHostStdoutWrite(() => terminal.hideCursor()),
    showCursor: () => withHostStdoutWrite(() => terminal.showCursor()),
    clearLine: () => withHostStdoutWrite(() => terminal.clearLine()),
    clearFromCursor: () => withHostStdoutWrite(() => terminal.clearFromCursor()),
    clearScreen: () => withHostStdoutWrite(() => terminal.clearScreen()),
    setTitle: (title) => withHostStdoutWrite(() => terminal.setTitle(title)),
    setProgress: (active) => withHostStdoutWrite(() => terminal.setProgress(active)),
  };
}

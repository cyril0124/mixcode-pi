import type { Terminal } from "@earendil-works/pi-tui";

export const MOUSE_REPORTING_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_REPORTING_DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
export const AUTOWRAP_DISABLE = "\x1b[?7l";
export const AUTOWRAP_ENABLE = "\x1b[?7h";

/** Forwards Terminal I/O and exposes inject() onto the TUI stdin callback. */
export class InjectingTerminal implements Terminal {
  private onInput: ((data: string) => void) | undefined;

  constructor(private readonly inner: Terminal) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.inner.start(onInput, onResize);
  }

  inject(data: string): void {
    if (!this.onInput) throw new Error("Cannot inject input before the TUI starts");
    this.onInput(data);
  }

  stop(): void {
    this.inner.stop();
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.inner.drainInput(maxMs, idleMs);
  }

  write(data: string): void {
    this.inner.write(data);
  }

  get columns(): number {
    return this.inner.columns;
  }

  get rows(): number {
    return this.inner.rows;
  }

  get kittyProtocolActive(): boolean {
    return this.inner.kittyProtocolActive;
  }

  moveBy(lines: number): void {
    this.inner.moveBy(lines);
  }

  hideCursor(): void {
    this.inner.hideCursor();
  }

  showCursor(): void {
    this.inner.showCursor();
  }

  clearLine(): void {
    this.inner.clearLine();
  }

  clearFromCursor(): void {
    this.inner.clearFromCursor();
  }

  clearScreen(): void {
    this.inner.clearScreen();
  }

  setTitle(title: string): void {
    this.inner.setTitle(title);
  }

  setProgress(active: boolean): void {
    this.inner.setProgress(active);
  }
}

/**
 * External programs sharing the tty (vim, less, `reset`, embedded shells) can
 * clear mouse reporting on exit, leaving the mouse dead while keyboard input
 * still works. DECSET is idempotent, so re-sending the enable sequence every
 * interval recovers automatically. This runs on a timer because an idle app
 * writes nothing else that could carry the sequence.
 */
const MOUSE_REPORTING_REASSERT_INTERVAL_MS = 1000;

export class MouseReportingTerminal implements Terminal {
  private started = false;
  private reassertTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly inner: Terminal) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start(onInput, onResize);
    this.inner.clearScreen();
    this.inner.write(`${AUTOWRAP_DISABLE}${MOUSE_REPORTING_ENABLE}`);
    this.started = true;
    this.stopReassert();
    this.reassertTimer = setInterval(
      () => this.inner.write(MOUSE_REPORTING_ENABLE),
      MOUSE_REPORTING_REASSERT_INTERVAL_MS,
    );
    this.reassertTimer.unref?.();
  }

  private stopReassert(): void {
    if (this.reassertTimer) clearInterval(this.reassertTimer);
    this.reassertTimer = undefined;
  }

  stop(): void {
    this.stopReassert();
    if (this.started) this.inner.write(`${MOUSE_REPORTING_DISABLE}${AUTOWRAP_ENABLE}`);
    this.started = false;
    this.inner.stop();
  }

  async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    // Shutdown path: the timer must not re-enable mouse reporting while input
    // drains, or late mouse events would leak to the parent shell.
    this.stopReassert();
    if (this.started) this.inner.write(`${MOUSE_REPORTING_DISABLE}${AUTOWRAP_ENABLE}`);
    await this.inner.drainInput(maxMs, idleMs);
  }

  write(data: string): void {
    this.inner.write(data);
  }

  get columns(): number {
    return this.inner.columns;
  }

  get rows(): number {
    return this.inner.rows;
  }

  get kittyProtocolActive(): boolean {
    return this.inner.kittyProtocolActive;
  }

  moveBy(lines: number): void {
    this.inner.moveBy(lines);
  }

  hideCursor(): void {
    this.inner.hideCursor();
  }

  showCursor(): void {
    this.inner.showCursor();
  }

  clearLine(): void {
    this.inner.clearLine();
  }

  clearFromCursor(): void {
    this.inner.clearFromCursor();
  }

  clearScreen(): void {
    this.inner.clearScreen();
  }

  setTitle(title: string): void {
    this.inner.setTitle(title);
  }

  setProgress(active: boolean): void {
    this.inner.setProgress(active);
  }
}

export function withMouseReporting(terminal: Terminal): Terminal {
  return new MouseReportingTerminal(terminal);
}

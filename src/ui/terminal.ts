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

export class MouseReportingTerminal implements Terminal {
  private started = false;

  constructor(private readonly inner: Terminal) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start(onInput, onResize);
    this.inner.clearScreen();
    this.inner.write(`${AUTOWRAP_DISABLE}${MOUSE_REPORTING_ENABLE}`);
    this.started = true;
  }

  stop(): void {
    if (this.started) this.inner.write(`${MOUSE_REPORTING_DISABLE}${AUTOWRAP_ENABLE}`);
    this.started = false;
    this.inner.stop();
  }

  async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
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

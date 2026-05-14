/**
 * Detects paste-without-bracketed-paste by tracking rapid input timing.
 *
 * When a terminal does not support bracketed paste mode, pasted text arrives
 * as individual characters at a rate far faster than human typing. This module
 * tracks input event timestamps and determines whether the current input is
 * likely part of a paste operation.
 */

// Threshold: if 3+ characters arrive within this window, treat as paste.
const PASTE_WINDOW_MS = 5;
const PASTE_MIN_EVENTS = 3;

export class PasteDetector {
  private timestamps: number[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Call on every input event to record its arrival time. */
  recordInput(data: string): void {
    // Only track single printable characters and newline/carriage-return.
    // Ignore escape sequences (mouse, function keys, etc.) to avoid false positives.
    if (data.length !== 1) return;
    const code = data.charCodeAt(0);
    if (code < 0x20 && code !== 0x0d && code !== 0x0a) return;

    const now = this.now();
    this.timestamps.push(now);
    // Keep only recent timestamps within the detection window
    const cutoff = now - PASTE_WINDOW_MS;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
  }

  /** Returns true if recent input timing suggests a paste operation. */
  isLikelyPaste(): boolean {
    return this.timestamps.length >= PASTE_MIN_EVENTS;
  }
}

export const pasteDetector = new PasteDetector();

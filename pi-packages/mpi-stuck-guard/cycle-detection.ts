const TRACK_WINDOW = 64;
const MIN_PERIOD = 2;
const MAX_PERIOD = 6;
const REPETITION_THRESHOLD = 3;

interface CallRecord {
  readonly tool: string;
  readonly signature: string;
}

export interface CycleNotice {
  readonly period: number;
  readonly count: number;
  readonly tools: readonly string[];
}

/** Detect exact repeating suffixes; rotations share one reminder gate. */
export class CycleDetection {
  private calls: CallRecord[] = [];
  private pattern: string[] | undefined;
  private lastNoticeCount = 0;

  reset(): void {
    this.calls = [];
    this.pattern = undefined;
    this.lastNoticeCount = 0;
  }

  record(tool: string, input: string): CycleNotice | undefined {
    this.calls.push({ tool, signature: `${tool}\u0000${input}` });
    if (this.calls.length > TRACK_WINDOW) this.calls.shift();
    const total = this.calls.length;
    for (let period = MIN_PERIOD; period <= MAX_PERIOD; period++) {
      if (total < period * REPETITION_THRESHOLD) break;
      let matchingCalls = 0;
      for (let index = total - 1; index >= period; index--) {
        if (this.calls[index]!.signature !== this.calls[index - period]!.signature) break;
        matchingCalls++;
      }
      const count = Math.floor(matchingCalls / period) + 1;
      if (count < REPETITION_THRESHOLD) continue;
      const cycle = this.calls.slice(-period);
      const signatures = cycle.map((call) => call.signature);
      if (new Set(signatures).size < 2) continue;
      // Rotations such as ABAB and BABA share the same reminder gate.
      const previous = this.pattern;
      const sameCycle =
        previous?.length === period &&
        signatures.some((_, offset) =>
          signatures.every((signature, index) => signature === previous[(index + offset) % period]),
        );
      if (!sameCycle) {
        this.pattern = signatures;
        this.lastNoticeCount = 0;
      }
      const ceiling = Math.floor(TRACK_WINDOW / period);
      if (
        this.lastNoticeCount > 0 &&
        count < this.lastNoticeCount * 2 &&
        !(count === ceiling && this.lastNoticeCount < ceiling)
      ) {
        return undefined;
      }
      this.lastNoticeCount = count;
      return { period, count, tools: cycle.map((call) => call.tool) };
    }
    this.pattern = undefined;
    this.lastNoticeCount = 0;
    return undefined;
  }
}

import * as assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  applyActiveTabShimmer,
  TAB_ACTIVE_SHIMMER_PERIOD_MS,
  TAB_ACTIVE_SHIMMER_SWEEP_MS,
} from "../src/ui/rendering/chrome.js";

test("applyActiveTabShimmer applies highlight wave during sweep and returns plain during rest", () => {
  const text = "Agent-01";
  const start = 0;

  // Mid-sweep: active wave styling applied
  const midSweep = start + Math.floor(TAB_ACTIVE_SHIMMER_SWEEP_MS / 2);
  const resultMid = applyActiveTabShimmer(text, start, midSweep);
  assert.notEqual(resultMid, text);
  assert.ok(resultMid.includes("\x1b["));

  // Rest phase: returns original text (period 3000ms, sweep 2000ms, rest 1000ms)
  const restPhase = start + TAB_ACTIVE_SHIMMER_SWEEP_MS + 100;
  const resultRest = applyActiveTabShimmer(text, start, restPhase);
  assert.equal(resultRest, text);

  // Animation timings the redraw interval in app-runtime.ts is tuned against.
  assert.equal(TAB_ACTIVE_SHIMMER_PERIOD_MS, 3000);
  assert.equal(TAB_ACTIVE_SHIMMER_SWEEP_MS, 2000);

  // Next cycle sweep: active wave styling applied again (continuous)
  const nextCycleMid =
    start + TAB_ACTIVE_SHIMMER_PERIOD_MS + Math.floor(TAB_ACTIVE_SHIMMER_SWEEP_MS / 2);
  const resultNext = applyActiveTabShimmer(text, start, nextCycleMid);
  assert.notEqual(resultNext, text);
  assert.ok(resultNext.includes("\x1b["));
});

test("applyActiveTabShimmer mirrors the return leg of the bounce", () => {
  const text = "Agent-01";
  const start = 0;
  const at = (fraction: number) =>
    applyActiveTabShimmer(text, start, Math.floor(TAB_ACTIVE_SHIMMER_SWEEP_MS * fraction));
  const headIsLit = (rendered: string) => rendered.startsWith("\x1b[");

  // Triangle wave: each frame on the return leg matches its mirror on the
  // outbound leg, so the wave retraces its path instead of jumping back.
  assert.equal(at(0.25), at(0.75));
  assert.equal(at(0.1), at(0.9));

  // The wave covers the full label: on the first character at cycle start,
  // clear of it by the turnaround.
  assert.equal(headIsLit(at(0)), true);
  assert.equal(headIsLit(at(0.5)), false);

  // Styling never alters the underlying label.
  assert.equal(stripTerminalSequences(at(0.5)), text);
});

test("applyActiveTabShimmer resets cycle when activatedAt changes", () => {
  const text = "Agent-01";
  const t0 = 1000;
  const tMid = t0 + 700; // in sweep
  assert.notEqual(applyActiveTabShimmer(text, t0, tMid), text);

  const tRest = t0 + 2200; // in rest: 2000 <= 2200 < 3000
  assert.equal(applyActiveTabShimmer(text, t0, tRest), text);

  // Tab switch occurs at tRest: new activatedAt = tRest
  const tSwitch = tRest;
  // Immediately at switch time: at start of new cycle sweep
  const resultAtSwitch = applyActiveTabShimmer(text, tSwitch, tSwitch + 100);
  assert.notEqual(resultAtSwitch, text);
  assert.ok(resultAtSwitch.includes("\x1b["));
});

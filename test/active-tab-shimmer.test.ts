import * as assert from "node:assert/strict";
import test from "node:test";
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

  // Rest phase: returns original text (period 2000ms, sweep 1400ms, rest 600ms)
  const restPhase = start + TAB_ACTIVE_SHIMMER_SWEEP_MS + 100;
  const resultRest = applyActiveTabShimmer(text, start, restPhase);
  assert.equal(resultRest, text);

  // Exact period boundary checks
  assert.equal(TAB_ACTIVE_SHIMMER_PERIOD_MS, 2000);
  assert.equal(TAB_ACTIVE_SHIMMER_SWEEP_MS, 1400);
  assert.equal(TAB_ACTIVE_SHIMMER_PERIOD_MS - TAB_ACTIVE_SHIMMER_SWEEP_MS, 600);

  // Next cycle sweep: active wave styling applied again (continuous)
  const nextCycleMid = start + TAB_ACTIVE_SHIMMER_PERIOD_MS + Math.floor(TAB_ACTIVE_SHIMMER_SWEEP_MS / 2);
  const resultNext = applyActiveTabShimmer(text, start, nextCycleMid);
  assert.notEqual(resultNext, text);
  assert.ok(resultNext.includes("\x1b["));
});

test("applyActiveTabShimmer resets cycle when activatedAt changes", () => {
  const text = "Agent-01";
  const t0 = 1000;
  const tMid = t0 + 700; // in sweep
  assert.notEqual(applyActiveTabShimmer(text, t0, tMid), text);

  const tRest = t0 + 1600; // in rest (1600 > 1400)
  assert.equal(applyActiveTabShimmer(text, t0, tRest), text);

  // Tab switch occurs at tRest: new activatedAt = tRest
  const tSwitch = tRest;
  // Immediately at switch time: at start of new cycle sweep
  const resultAtSwitch = applyActiveTabShimmer(text, tSwitch, tSwitch + 100);
  assert.notEqual(resultAtSwitch, text);
  assert.ok(resultAtSwitch.includes("\x1b["));
});

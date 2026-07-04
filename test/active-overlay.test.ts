// Tests for the active-overlay seam (src/core/overlays.ts).
//
// MixCodeState carries ~9 state-level overlays as heterogeneous fields (top-level
// booleans, nested .open flags, and a presence-based picker). The invariant is
// "at most one state-level overlay active at a time", previously enforced by
// drifting OR-lists scattered across app-input.ts / app-key-handlers.ts and an
// ad-hoc close-list in openQuitConfirm. These tests lock the single discriminant
// (activeOverlay), the mutual-exclusion open (openOverlay), and the unified close.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState } from "../src/core/defaults.js";
import {
  activeOverlay,
  closeActiveOverlay,
  isOverlayActive,
  openOverlay,
  type OverlayKind,
} from "../src/core/overlays.js";

function state() {
  return createInitialState("/tmp");
}

// The fixed priority order the discriminant must follow, mirroring the routing
// cascade short-circuit sequence in app-input.ts.
const PRIORITY: OverlayKind[] = [
  "workspace",
  "tree-selector",
  "picker",
  "session-selector",
  "command-palette",
  "extension-manager",
  "tab-jump",
  "quit-confirm",
  "delete-all-sessions-confirm",
  "close-all-sessions-confirm",
];

const FLAG_KINDS: Exclude<OverlayKind, "picker">[] = [
  "workspace",
  "tree-selector",
  "session-selector",
  "command-palette",
  "extension-manager",
  "tab-jump",
  "quit-confirm",
  "delete-all-sessions-confirm",
  "close-all-sessions-confirm",
];

test("activeOverlay returns 'none' on a fresh state", () => {
  assert.equal(activeOverlay(state()), "none");
  assert.equal(isOverlayActive(state()), false);
});

test("openOverlay activates exactly the requested flag overlay", () => {
  for (const kind of FLAG_KINDS) {
    const s = state();
    openOverlay(s, kind);
    assert.equal(activeOverlay(s), kind, `activeOverlay should report ${kind}`);
    assert.equal(isOverlayActive(s), true);
  }
});

test("openOverlay is mutually exclusive: opening a new overlay closes the previous", () => {
  const s = state();
  openOverlay(s, "command-palette");
  assert.equal(activeOverlay(s), "command-palette");
  openOverlay(s, "tab-jump");
  // tab-jump now active, command-palette must be cleared
  assert.equal(activeOverlay(s), "tab-jump");
  assert.equal(s.commandPaletteOpen, false);
});

test("openOverlay closes an active picker (mutual exclusion across representations)", () => {
  const s = state();
  s.picker = { kind: "models", title: "", query: "", selectedIndex: 0, items: [] };
  assert.equal(activeOverlay(s), "picker");
  openOverlay(s, "command-palette");
  assert.equal(activeOverlay(s), "command-palette");
  assert.equal(s.picker, undefined);
});

test("closeActiveOverlay clears whichever overlay is active, including picker", () => {
  for (const kind of FLAG_KINDS) {
    const s = state();
    openOverlay(s, kind);
    closeActiveOverlay(s);
    assert.equal(activeOverlay(s), "none", `${kind} should be cleared`);
    assert.equal(isOverlayActive(s), false);
  }
  const s = state();
  s.picker = { kind: "models", title: "", query: "", selectedIndex: 0, items: [] };
  closeActiveOverlay(s);
  assert.equal(activeOverlay(s), "none");
});

test("activeOverlay follows the fixed priority when multiple flags are set", () => {
  // Force two overlays on simultaneously (a state that should not occur in
  // practice) and assert the higher-priority one wins deterministically.
  const s = state();
  openOverlay(s, "tab-jump");
  // raise a higher-priority flag directly, bypassing openOverlay's exclusion
  s.commandPaletteOpen = true;
  assert.equal(activeOverlay(s), "command-palette");
});

test("closeActiveOverlay on a fresh state is a no-op", () => {
  const s = state();
  closeActiveOverlay(s);
  assert.equal(activeOverlay(s), "none");
});

// Contract: pi-tui Kitty protocol flag is process-global (Symbol.for on
// globalThis), so duplicate module instances from bun --compile share one
// switch. Without this, one copy can parse keys as Kitty while another still
// uses legacy sequences (Shift+Enter / modifiers disagree).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isKittyProtocolActive as isPkgKitty, matchesKey, setKittyProtocolActive as setPkgKitty } from "@earendil-works/pi-tui";

const KEY = Symbol.for("@earendil-works/pi-tui:kitty-protocol");

test("setKittyProtocolActive stores flag on globalThis Symbol.for slot", () => {
  const previousActive = isPkgKitty();
  try {
    setPkgKitty(true);
    assert.equal((globalThis as Record<symbol, unknown>)[KEY], true);
    assert.equal(isPkgKitty(), true);

    setPkgKitty(false);
    assert.equal((globalThis as Record<symbol, unknown>)[KEY], false);
    assert.equal(isPkgKitty(), false);
  } finally {
    setPkgKitty(previousActive);
  }
});

test("CJS require of keys.js shares kitty state with package import", () => {
  const require = createRequire(import.meta.url);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const keysPath = path.join(repoRoot, "node_modules/@earendil-works/pi-tui/dist/keys.js");
  const cjs = require(keysPath) as {
    setKittyProtocolActive: (active: boolean) => void;
    isKittyProtocolActive: () => boolean;
    matchesKey: (data: string, keyId: string) => boolean;
  };

  const previousActive = isPkgKitty();
  try {
    setPkgKitty(true);
    assert.equal(cjs.isKittyProtocolActive(), true);
    // Entry-point resync: bare "\\n" is enter only when kitty is off.
    assert.equal(matchesKey("\n", "enter"), false);
    assert.equal(cjs.matchesKey("\n", "enter"), false);

    cjs.setKittyProtocolActive(false);
    assert.equal(isPkgKitty(), false);
    assert.equal(matchesKey("\n", "enter"), true);
  } finally {
    setPkgKitty(previousActive);
  }
});

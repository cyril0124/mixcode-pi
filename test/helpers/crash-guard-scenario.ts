import * as fs from "node:fs";
import { installCrashGuard } from "../../src/cli/crash-guard.js";

// Child process for test/crash-guard.test.ts: installs the real guard, then
// raises a fault the way a live TUI would (timer callback / detached promise).
// Runs in its own process because the guard ends in process.exit(1).
const [mode, teardownMarker] = process.argv.slice(2);

installCrashGuard(() => {
  fs.writeFileSync(String(teardownMarker), "torn down");
});

if (mode === "uncaught") {
  setTimeout(() => {
    throw new Error("scenario-uncaught-boom");
  }, 0);
} else if (mode === "rejection") {
  void Promise.reject(new Error("scenario-rejection-boom"));
} else {
  throw new Error(`unknown scenario mode: ${mode}`);
}

// Keep the loop alive like a running TUI would.
setTimeout(() => process.exit(0), 5_000);

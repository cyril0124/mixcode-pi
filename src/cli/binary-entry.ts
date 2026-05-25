// Standalone binary entry point.
// Must set PI_PACKAGE_DIR BEFORE any other module initializes, because
// pi-coding-agent's config module reads package.json eagerly at import time.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMBEDDED_PKG = JSON.stringify({
  name: "mixcode-pi",
  version: "0.1.0",
  piConfig: { name: "mixcode", configDir: ".mixcode-pi" },
});

const runtimeDir = join(tmpdir(), `mixcode-pi-${process.pid}`);
mkdirSync(runtimeDir, { recursive: true });
writeFileSync(join(runtimeDir, "package.json"), EMBEDDED_PKG);
process.env.PI_PACKAGE_DIR = runtimeDir;

// Clean up on exit
function cleanup() {
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

// Dynamic import ensures PI_PACKAGE_DIR is set before pi-coding-agent loads
const { main } = await import("./main.js");
await main();

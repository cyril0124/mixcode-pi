// Standalone binary entry point.
// Must set PI_PACKAGE_DIR BEFORE any other module initializes, because
// pi-coding-agent's config module reads package.json and built-in resources
// eagerly at import/render time.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import darkTheme from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json" with { type: "json" };
import lightTheme from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json" with { type: "json" };
import exportTemplateCss from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.css" with { type: "text" };
import exportTemplateHtml from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html" with { type: "text" };
import exportTemplateJs from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js" with { type: "text" };
import exportVendorMarked from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor/marked.min.js" with { type: "text" };
import exportVendorHighlight from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor/highlight.min.js" with { type: "text" };
import packageJson from "../../package.json" with { type: "json" };
import { materializeBinaryRuntimeAssets } from "./binary-assets.js";

// Use mkdtempSync for unpredictable temp dir name (avoids symlink attacks on shared systems)
const runtimeDir = mkdtempSync(join(tmpdir(), "mixcode-pi-"));

materializeBinaryRuntimeAssets(runtimeDir, {
  darkTheme,
  lightTheme,
  exportTemplateCss,
  exportTemplateHtml,
  exportTemplateJs,
  exportVendorMarked,
  exportVendorHighlight,
  packageJson,
});

// Note: clankolas.png (announcement image) is binary and cannot be bundled via
// `with { type: "text" }`. The upstream code gracefully degrades when the file
// is absent (try/catch around readFileSync), so we leave assets/ empty.

process.env.PI_PACKAGE_DIR = runtimeDir;

function cleanup() {
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup only.
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

// Dynamic import ensures PI_PACKAGE_DIR is set before pi-coding-agent loads.
// Bun's compiled executable can make main.ts look like the direct argv[1]
// entrypoint, so mark this import as wrapper-owned before loading it.
const BINARY_ENTRY_IMPORT_FLAG = Symbol.for("mixcode-pi.binary-entry-import");
(globalThis as Record<symbol, unknown>)[BINARY_ENTRY_IMPORT_FLAG] = true;
const { main } = await import("./main.js");
await main();

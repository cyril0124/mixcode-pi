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
import clankolasImagePath from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/assets/clankolas.png" with { type: "file" };
import photonWasmPath from "../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" };
import searchGuardIndex from "../../packages/search-guard/index.ts" with { type: "text" };
import searchGuardPackageJson from "../../packages/search-guard/package.json" with { type: "text" };
import imageHoistIndex from "../../packages/image-hoist/index.ts" with { type: "text" };
import imageHoistPackageJson from "../../packages/image-hoist/package.json" with { type: "text" };
import packageJson from "../../package.json" with { type: "json" };
import { materializeBinaryRuntimeAssets } from "./binary-assets.js";

// Static import of the nested pi-tui keybindings module that pi-coding-agent
// ships via its shrinkwrap. In a compiled binary, runtime module resolution
// (import.meta.resolve / createRequire) cannot locate this nested copy, so we
// import it statically and stash it on globalThis for the bridge to pick up.
// We cannot import the bridge directly here because it transitively pulls in
// pi-coding-agent which reads PI_PACKAGE_DIR eagerly (not yet set at this point).
import * as nestedPiTuiKeybindings from "../../node_modules/@earendil-works/pi-tui/dist/keybindings.js";

// Use mkdtempSync for unpredictable temp dir name (avoids symlink attacks on shared systems)
const runtimeDir = mkdtempSync(join(tmpdir(), "mixcode-pi-"));

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

materializeBinaryRuntimeAssets(runtimeDir, {
  darkTheme,
  lightTheme,
  exportTemplateCss,
  exportTemplateHtml,
  exportTemplateJs,
  exportVendorMarked,
  exportVendorHighlight,
  interactiveAssets: { "clankolas.png": clankolasImagePath },
  photonWasmPath,
  packageJson,
  builtinPackages: {
    "search-guard": {
      "index.ts": searchGuardIndex,
      "package.json": searchGuardPackageJson,
    },
    "image-hoist": {
      "index.ts": imageHoistIndex,
      "package.json": imageHoistPackageJson,
    },
  },
});

process.env.PI_PACKAGE_DIR = runtimeDir;

// Stash the nested pi-tui module on globalThis so the bridge can pick it up
// when it initializes. The bridge reads this symbol during module load.
const NESTED_PI_TUI_SYMBOL = Symbol.for("mixcode-pi.nested-pi-tui");
(globalThis as Record<symbol, unknown>)[NESTED_PI_TUI_SYMBOL] = nestedPiTuiKeybindings;

// Dynamic import ensures PI_PACKAGE_DIR is set before pi-coding-agent loads.
// Bun's compiled executable can make main.ts look like the direct argv[1]
// entrypoint, so mark this import as wrapper-owned before loading it.
const BINARY_ENTRY_IMPORT_FLAG = Symbol.for("mixcode-pi.binary-entry-import");
(globalThis as Record<symbol, unknown>)[BINARY_ENTRY_IMPORT_FLAG] = true;
const { main } = await import("./main.js");
await main();

// Standalone binary entry point.
// Must set PI_PACKAGE_DIR BEFORE any other module initializes, because
// pi-coding-agent's config module reads package.json and built-in resources
// eagerly at import/render time.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Use mkdtempSync for unpredictable temp dir name (avoids symlink attacks on shared systems)
const runtimeDir = mkdtempSync(join(tmpdir(), "mixcode-pi-"));
const themeDir = join(runtimeDir, "theme");
const exportHtmlDir = join(runtimeDir, "export-html");
const exportVendorDir = join(exportHtmlDir, "vendor");
const assetsDir = join(runtimeDir, "assets");
mkdirSync(themeDir, { recursive: true });
mkdirSync(exportVendorDir, { recursive: true });
mkdirSync(assetsDir, { recursive: true });

writeFileSync(
  join(runtimeDir, "package.json"),
  JSON.stringify({
    ...packageJson,
    piConfig: {
      name: "mixcode",
      configDir: ".mixcode-pi",
    },
  }),
);
writeFileSync(join(themeDir, "dark.json"), JSON.stringify(darkTheme));
writeFileSync(join(themeDir, "light.json"), JSON.stringify(lightTheme));

// Export-to-HTML template assets
writeFileSync(join(exportHtmlDir, "template.css"), exportTemplateCss);
writeFileSync(join(exportHtmlDir, "template.html"), exportTemplateHtml);
writeFileSync(join(exportHtmlDir, "template.js"), exportTemplateJs);
writeFileSync(join(exportVendorDir, "marked.min.js"), exportVendorMarked);
writeFileSync(join(exportVendorDir, "highlight.min.js"), exportVendorHighlight);

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
const { main } = await import("./main.js");
await main();

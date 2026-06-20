import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeBinaryRuntimeAssets } from "../src/cli/binary-assets.js";

test("binary runtime assets are written for both upstream Bun and dist layouts", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "mixcode-binary-assets-"));
  try {
    const sourceAsset = join(runtimeDir, "clankolas.png.source");
    const photonWasm = join(runtimeDir, "photon_rs_bg.wasm.source");
    await writeFile(sourceAsset, "image-bytes", "utf8");
    await writeFile(photonWasm, "wasm-bytes", "utf8");

    materializeBinaryRuntimeAssets(runtimeDir, {
      darkTheme: { name: "dark" },
      lightTheme: { name: "light" },
      exportTemplateCss: "css",
      exportTemplateHtml: "html",
      exportTemplateJs: "js",
      exportVendorMarked: "marked",
      exportVendorHighlight: "highlight",
      interactiveAssets: { "clankolas.png": sourceAsset },
      photonWasmPath: photonWasm,
      packageJson: {
        name: "mixcode-pi",
        version: "1.2.3",
        piConfig: { preserved: true, name: "old", configDir: ".old" },
      },
      builtinPackages: {
        "rpiv-todo": {
          "index.ts": "export default () => {};",
          "state/store.ts": "export const x = 1;",
        },
      },
    });

    const packageJson = JSON.parse(await readFile(join(runtimeDir, "package.json"), "utf8"));
    assert.equal(packageJson.name, "mixcode-pi");
    assert.equal(packageJson.version, "1.2.3");
    assert.equal(packageJson.piConfig.preserved, true);
    assert.equal(packageJson.piConfig.name, "mixcode");
    assert.equal(packageJson.piConfig.configDir, ".pi");

    for (const themeDir of [
      join(runtimeDir, "theme"),
      join(runtimeDir, "dist", "modes", "interactive", "theme"),
    ]) {
      assert.equal(await readFile(join(themeDir, "dark.json"), "utf8"), JSON.stringify({ name: "dark" }));
      assert.equal(await readFile(join(themeDir, "light.json"), "utf8"), JSON.stringify({ name: "light" }));
    }

    for (const exportHtmlDir of [
      join(runtimeDir, "export-html"),
      join(runtimeDir, "dist", "core", "export-html"),
    ]) {
      assert.equal(await readFile(join(exportHtmlDir, "template.css"), "utf8"), "css");
      assert.equal(await readFile(join(exportHtmlDir, "template.html"), "utf8"), "html");
      assert.equal(await readFile(join(exportHtmlDir, "template.js"), "utf8"), "js");
      assert.equal(await readFile(join(exportHtmlDir, "vendor", "marked.min.js"), "utf8"), "marked");
      assert.equal(
        await readFile(join(exportHtmlDir, "vendor", "highlight.min.js"), "utf8"),
        "highlight",
      );
    }

    for (const assetsDir of [
      join(runtimeDir, "assets"),
      join(runtimeDir, "dist", "modes", "interactive", "assets"),
    ]) {
      assert.equal((await stat(assetsDir)).isDirectory(), true);
      assert.equal(await readFile(join(assetsDir, "clankolas.png"), "utf8"), "image-bytes");
    }

    assert.equal(await readFile(join(runtimeDir, "photon_rs_bg.wasm"), "utf8"), "wasm-bytes");

    // Built-in packages: nested-path files (e.g. "state/store.ts") must land in
    // their subdirectory, not flattened. rpiv-todo relies on this.
    const pkgDir = join(runtimeDir, "packages", "rpiv-todo");
    assert.equal(await readFile(join(pkgDir, "index.ts"), "utf8"), "export default () => {};");
    assert.equal(await readFile(join(pkgDir, "state", "store.ts"), "utf8"), "export const x = 1;");
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

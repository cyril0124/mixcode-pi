import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeBinaryRuntimeAssets } from "../src/cli/binary-assets.js";

test("binary runtime assets are written for both upstream Bun and dist layouts", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "mixcode-binary-assets-"));
  try {
    materializeBinaryRuntimeAssets(runtimeDir, {
      darkTheme: { name: "dark" },
      lightTheme: { name: "light" },
      exportTemplateCss: "css",
      exportTemplateHtml: "html",
      exportTemplateJs: "js",
      exportVendorMarked: "marked",
      exportVendorHighlight: "highlight",
      packageJson: { name: "mixcode-pi", version: "1.2.3" },
    });

    const packageJson = JSON.parse(await readFile(join(runtimeDir, "package.json"), "utf8"));
    assert.equal(packageJson.piConfig.name, "mixcode");
    assert.equal(packageJson.piConfig.configDir, ".mixcode-pi");

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
    }
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

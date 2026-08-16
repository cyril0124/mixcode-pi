import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { materializeBinaryRuntimeAssets } from "../src/cli/binary-assets.js";
import { ensurePackageExtensions } from "../src/core/ensure-package-extensions.js";

test("binary runtime assets are written for both upstream Bun and dist layouts", async () => {
  const runtimeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-binary-assets-"));
  try {
    const sourceAsset = path.join(runtimeDir, "clankolas.png.source");
    const photonWasm = path.join(runtimeDir, "photon_rs_bg.wasm.source");
    await fsPromises.writeFile(sourceAsset, "image-bytes", "utf8");
    await fsPromises.writeFile(photonWasm, "wasm-bytes", "utf8");

    await materializeBinaryRuntimeAssets(runtimeDir, {
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
        "mpi-example": {
          "index.ts": "export default () => {};",
          "state/store.ts": "export const x = 1;",
        },
      },
    });

    const packageJson = JSON.parse(await fsPromises.readFile(path.join(runtimeDir, "package.json"), "utf8"));
    assert.equal(packageJson.name, "mixcode-pi");
    assert.equal(packageJson.version, "1.2.3");
    assert.equal(packageJson.piConfig.preserved, true);
    // Do not rebrand package identity as mixcode: PI_PACKAGE_DIR is inherited by
    // child `pi` processes, and piConfig.name drives APP_NAME / ENV_AGENT_DIR.
    assert.equal(packageJson.piConfig.name, undefined);
    assert.equal(packageJson.piConfig.configDir, ".pi");

    for (const themeDir of [
      path.join(runtimeDir, "theme"),
      path.join(runtimeDir, "dist", "modes", "interactive", "theme"),
    ]) {
      assert.equal(await fsPromises.readFile(path.join(themeDir, "dark.json"), "utf8"), JSON.stringify({ name: "dark" }));
      assert.equal(await fsPromises.readFile(path.join(themeDir, "light.json"), "utf8"), JSON.stringify({ name: "light" }));
    }

    for (const exportHtmlDir of [
      path.join(runtimeDir, "export-html"),
      path.join(runtimeDir, "dist", "core", "export-html"),
    ]) {
      assert.equal(await fsPromises.readFile(path.join(exportHtmlDir, "template.css"), "utf8"), "css");
      assert.equal(await fsPromises.readFile(path.join(exportHtmlDir, "template.html"), "utf8"), "html");
      assert.equal(await fsPromises.readFile(path.join(exportHtmlDir, "template.js"), "utf8"), "js");
      assert.equal(await fsPromises.readFile(path.join(exportHtmlDir, "vendor", "marked.min.js"), "utf8"), "marked");
      assert.equal(
        await fsPromises.readFile(path.join(exportHtmlDir, "vendor", "highlight.min.js"), "utf8"),
        "highlight",
      );
    }

    for (const assetsDir of [
      path.join(runtimeDir, "assets"),
      path.join(runtimeDir, "dist", "modes", "interactive", "assets"),
    ]) {
      assert.equal((await fsPromises.stat(assetsDir)).isDirectory(), true);
      assert.equal(await fsPromises.readFile(path.join(assetsDir, "clankolas.png"), "utf8"), "image-bytes");
    }

    assert.equal(await fsPromises.readFile(path.join(runtimeDir, "photon_rs_bg.wasm"), "utf8"), "wasm-bytes");

    // Built-in packages: nested-path files (e.g. "state/store.ts") must land in
    // their subdirectory, not flattened.
    const pkgDir = path.join(runtimeDir, "packages", "mpi-example");
    assert.equal(await fsPromises.readFile(path.join(pkgDir, "index.ts"), "utf8"), "export default () => {};");
    assert.equal(await fsPromises.readFile(path.join(pkgDir, "state", "store.ts"), "utf8"), "export const x = 1;");
  } finally {
    await fsPromises.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("binary runtime built-in packages are installed as Pi extensions", async () => {
  const oldHome = process.env.HOME;
  const homeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-binary-home-"));
  const runtimeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-binary-assets-"));
  try {
    process.env.HOME = homeDir;
    await materializeBinaryRuntimeAssets(runtimeDir, {
      darkTheme: {},
      lightTheme: {},
      exportTemplateCss: "",
      exportTemplateHtml: "",
      exportTemplateJs: "",
      exportVendorMarked: "",
      exportVendorHighlight: "",
      packageJson: {},
      builtinPackages: {
        "probe-extension": {
          "index.ts": "export default () => {};",
          "package.json": JSON.stringify({
            name: "probe-extension",
            version: "0.0.0",
            type: "module",
            pi: { extensions: ["./index.ts"] },
          }),
        },
      },
    });

    ensurePackageExtensions(runtimeDir, { copy: true });

    assert.equal(
      await fsPromises.readFile(path.join(homeDir, ".pi", "agent", "extensions", "probe-extension", "index.ts"), "utf8"),
      "export default () => {};",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsPromises.rm(runtimeDir, { recursive: true, force: true });
    await fsPromises.rm(homeDir, { recursive: true, force: true });
  }
});

test("ensurePackageExtensions installs under the given agentDir, not global home", async () => {
  const oldHome = process.env.HOME;
  const homeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-agentdir-home-"));
  const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-agentdir-"));
  const runtimeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-agentdir-runtime-"));
  try {
    // Point HOME at an empty dir so a leak into the default root would be visible.
    process.env.HOME = homeDir;
    await materializeBinaryRuntimeAssets(runtimeDir, {
      darkTheme: {},
      lightTheme: {},
      exportTemplateCss: "",
      exportTemplateHtml: "",
      exportTemplateJs: "",
      exportVendorMarked: "",
      exportVendorHighlight: "",
      packageJson: {},
      builtinPackages: {
        "probe-extension": {
          "index.ts": "export default () => {};",
          "package.json": JSON.stringify({
            name: "probe-extension",
            version: "0.0.0",
            type: "module",
            pi: { extensions: ["./index.ts"], skills: ["./skills"] },
          }),
          "skills/probe-skill/SKILL.md": "---\nname: probe-skill\ndescription: probe\n---\n",
        },
      },
    });

    const installedExtensionPaths = ensurePackageExtensions(runtimeDir, { copy: true, agentDir });

    // Installed under the effective agentDir/extensions ...
    assert.equal(
      await fsPromises.readFile(path.join(agentDir, "extensions", "probe-extension", "index.ts"), "utf8"),
      "export default () => {};",
    );
    assert.deepEqual(installedExtensionPaths, [path.join(agentDir, "extensions", "probe-extension")]);
    await assert.rejects(fsPromises.stat(path.join(agentDir, "skills", "probe-skill")), /ENOENT/);

    // ... and NOT under the default global home root.
    await assert.rejects(
      fsPromises.stat(path.join(homeDir, ".pi", "agent", "extensions", "probe-extension")),
      /ENOENT/,
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsPromises.rm(runtimeDir, { recursive: true, force: true });
    await fsPromises.rm(homeDir, { recursive: true, force: true });
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});

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

    ensurePackageExtensions(runtimeDir);

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

test("ensurePackageExtensions uses the same hash sync for source and binary package roots", async () => {
  for (const packageRootName of ["pi-packages", "packages"]) {
    const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `mixcode-${packageRootName}-`));
    const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `mixcode-${packageRootName}-agent-`));
    const packageName = `probe-${packageRootName}`;
    const packageDir = path.join(rootDir, packageRootName, packageName);
    try {
      await fsPromises.mkdir(packageDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: packageName,
          version: "0.0.0",
          type: "module",
          pi: { extensions: ["./index.ts"] },
        }),
        "utf8",
      );
      await fsPromises.writeFile(path.join(packageDir, "index.ts"), "export default 0;\n", "utf8");

      const installed = path.join(agentDir, "extensions", packageName);
      ensurePackageExtensions(rootDir, { agentDir });
      assert.equal((await fsPromises.lstat(installed)).isSymbolicLink(), false);

      const oldTime = new Date("2000-01-01T00:00:00.000Z");
      const installedIndex = path.join(installed, "index.ts");
      const installedHash = path.join(installed, ".mixcode-package-hash");
      await fsPromises.utimes(installedIndex, oldTime, oldTime);
      await fsPromises.utimes(installedHash, oldTime, oldTime);
      const unchangedTime = (await fsPromises.stat(installedIndex)).mtimeMs;
      const unchangedHashTime = (await fsPromises.stat(installedHash)).mtimeMs;
      ensurePackageExtensions(rootDir, { agentDir });
      assert.equal((await fsPromises.stat(installedIndex)).mtimeMs, unchangedTime);
      assert.equal((await fsPromises.stat(installedHash)).mtimeMs, unchangedHashTime);

      await fsPromises.writeFile(path.join(installed, "stale.ts"), "stale\n", "utf8");
      await fsPromises.writeFile(path.join(packageDir, "index.ts"), "export default 1;\n", "utf8");
      ensurePackageExtensions(rootDir, { agentDir });
      assert.equal(await fsPromises.readFile(installedIndex, "utf8"), "export default 1;\n");
      await assert.rejects(fsPromises.stat(path.join(installed, "stale.ts")), /ENOENT/);
    } finally {
      await fsPromises.rm(rootDir, { recursive: true, force: true });
      await fsPromises.rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("ensurePackageExtensions leaves no success hash after a failed sync", async () => {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-failed-sync-"));
  const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-failed-sync-agent-"));
  const packageDir = path.join(rootDir, "pi-packages", "probe-extension");
  const extensionsDir = path.join(agentDir, "extensions");
  const installedDir = path.join(extensionsDir, "probe-extension");
  const installedIndex = path.join(installedDir, "index.ts");
  try {
    await fsPromises.mkdir(packageDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "probe-extension", pi: { extensions: ["./index.ts"] } }),
      "utf8",
    );
    await fsPromises.writeFile(path.join(packageDir, "index.ts"), "export default 1;\n", "utf8");
    await fsPromises.mkdir(extensionsDir, { recursive: true });
    await fsPromises.chmod(extensionsDir, 0o500);

    assert.throws(() => ensurePackageExtensions(rootDir, { agentDir }), /EACCES|EPERM/);
    await assert.rejects(fsPromises.stat(path.join(installedDir, ".mixcode-package-hash")), /ENOENT/);

    await fsPromises.chmod(extensionsDir, 0o700);
    ensurePackageExtensions(rootDir, { agentDir });
    assert.equal(await fsPromises.readFile(installedIndex, "utf8"), "export default 1;\n");
  } finally {
    try {
      await fsPromises.chmod(extensionsDir, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fsPromises.rm(rootDir, { recursive: true, force: true });
    await fsPromises.rm(agentDir, { recursive: true, force: true });
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

    const installedExtensionPaths = ensurePackageExtensions(runtimeDir, { agentDir });

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

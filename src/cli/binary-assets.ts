import * as path from "node:path";

export interface BinaryRuntimeAssets {
  darkTheme: unknown;
  lightTheme: unknown;
  exportTemplateCss: string;
  exportTemplateHtml: string;
  exportTemplateJs: string;
  exportVendorMarked: string;
  exportVendorHighlight: string;
  interactiveAssets?: Record<string, string>;
  photonWasmPath?: string;
  packageJson: Record<string, unknown>;
  /** Built-in extension packages: { packageName: { filename: content } } */
  builtinPackages?: Record<string, Record<string, string>>;
}

export async function materializeBinaryRuntimeAssets(
  runtimeDir: string,
  assets: BinaryRuntimeAssets,
): Promise<void> {
  const themeDirs = [
    path.join(runtimeDir, "theme"),
    path.join(runtimeDir, "dist", "modes", "interactive", "theme"),
  ];
  const exportHtmlDirs = [
    path.join(runtimeDir, "export-html"),
    path.join(runtimeDir, "dist", "core", "export-html"),
  ];
  const assetsDirs = [
    path.join(runtimeDir, "assets"),
    path.join(runtimeDir, "dist", "modes", "interactive", "assets"),
  ];

  await writePackageJson(runtimeDir, assets.packageJson);
  for (const themeDir of themeDirs) await writeThemes(themeDir, assets);
  for (const exportHtmlDir of exportHtmlDirs) await writeExportHtmlAssets(exportHtmlDir, assets);
  for (const assetsDir of assetsDirs) {
    await writeInteractiveAssets(assetsDir, assets.interactiveAssets ?? {});
  }
  if (assets.photonWasmPath) await writePhotonWasm(runtimeDir, assets.photonWasmPath);
  if (assets.builtinPackages) await writeBuiltinPackages(runtimeDir, assets.builtinPackages);
}

async function writePackageJson(
  runtimeDir: string,
  packageJson: Record<string, unknown>,
): Promise<void> {
  // Keep configDir under ~/.pi so credentials/sessions stay shared with Pi.
  // Do NOT set piConfig.name to "mixcode": PI_PACKAGE_DIR is process-global and
  // inherited by child `pi` CLIs; name drives APP_NAME / ENV_AGENT_DIR, which
  // would make `pi --help` show MIXCODE_CODING_AGENT_DIR. Mixcode agent-dir
  // overrides stay on MIXCODE_CODING_AGENT_DIR via bootstrap only.
  const piConfig = isRecord(packageJson.piConfig) ? { ...packageJson.piConfig } : {};
  delete piConfig.name;
  piConfig.configDir = ".pi";
  await Bun.write(
    path.join(runtimeDir, "package.json"),
    JSON.stringify({
      ...packageJson,
      piConfig,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeThemes(
  themeDir: string,
  assets: Pick<BinaryRuntimeAssets, "darkTheme" | "lightTheme">,
): Promise<void> {
  await Bun.write(path.join(themeDir, "dark.json"), JSON.stringify(assets.darkTheme));
  await Bun.write(path.join(themeDir, "light.json"), JSON.stringify(assets.lightTheme));
}

async function writeExportHtmlAssets(
  exportHtmlDir: string,
  assets: Pick<
    BinaryRuntimeAssets,
    | "exportTemplateCss"
    | "exportTemplateHtml"
    | "exportTemplateJs"
    | "exportVendorMarked"
    | "exportVendorHighlight"
  >,
): Promise<void> {
  const exportVendorDir = path.join(exportHtmlDir, "vendor");
  await Bun.write(path.join(exportHtmlDir, "template.css"), assets.exportTemplateCss);
  await Bun.write(path.join(exportHtmlDir, "template.html"), assets.exportTemplateHtml);
  await Bun.write(path.join(exportHtmlDir, "template.js"), assets.exportTemplateJs);
  await Bun.write(path.join(exportVendorDir, "marked.min.js"), assets.exportVendorMarked);
  await Bun.write(path.join(exportVendorDir, "highlight.min.js"), assets.exportVendorHighlight);
}

async function writeInteractiveAssets(
  assetsDir: string,
  assetPathsByName: Record<string, string>,
): Promise<void> {
  for (const [name, assetPath] of Object.entries(assetPathsByName)) {
    await Bun.write(path.join(assetsDir, name), Bun.file(assetPath));
  }
}

async function writePhotonWasm(runtimeDir: string, photonWasmPath: string): Promise<void> {
  await Bun.write(path.join(runtimeDir, "photon_rs_bg.wasm"), Bun.file(photonWasmPath));
}

async function writeBuiltinPackages(
  runtimeDir: string,
  packages: Record<string, Record<string, string>>,
): Promise<void> {
  for (const [name, files] of Object.entries(packages)) {
    const pkgDir = path.join(runtimeDir, "packages", name);
    for (const [filename, content] of Object.entries(files)) {
      // filename may contain subdirectories (e.g. "state/store.ts" for
      // multi-file packages); Bun.write creates parent dirs.
      await Bun.write(path.join(pkgDir, filename), content);
    }
  }
}

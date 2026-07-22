import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

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

export function materializeBinaryRuntimeAssets(
  runtimeDir: string,
  assets: BinaryRuntimeAssets,
): void {
  const themeDirs = [
    join(runtimeDir, "theme"),
    join(runtimeDir, "dist", "modes", "interactive", "theme"),
  ];
  const exportHtmlDirs = [
    join(runtimeDir, "export-html"),
    join(runtimeDir, "dist", "core", "export-html"),
  ];
  const assetsDirs = [
    join(runtimeDir, "assets"),
    join(runtimeDir, "dist", "modes", "interactive", "assets"),
  ];

  writePackageJson(runtimeDir, assets.packageJson);
  for (const themeDir of themeDirs) writeThemes(themeDir, assets);
  for (const exportHtmlDir of exportHtmlDirs) writeExportHtmlAssets(exportHtmlDir, assets);
  for (const assetsDir of assetsDirs) writeInteractiveAssets(assetsDir, assets.interactiveAssets ?? {});
  if (assets.photonWasmPath) writePhotonWasm(runtimeDir, assets.photonWasmPath);
  if (assets.builtinPackages) writeBuiltinPackages(runtimeDir, assets.builtinPackages);
}

function writePackageJson(runtimeDir: string, packageJson: Record<string, unknown>): void {
  // Keep configDir under ~/.pi so credentials/sessions stay shared with Pi.
  // Do NOT set piConfig.name to "mixcode": PI_PACKAGE_DIR is process-global and
  // inherited by child `pi` CLIs; name drives APP_NAME / ENV_AGENT_DIR, which
  // would make `pi --help` show MIXCODE_CODING_AGENT_DIR. Mixcode agent-dir
  // overrides stay on MIXCODE_CODING_AGENT_DIR via bootstrap only.
  const piConfig = isRecord(packageJson.piConfig) ? { ...packageJson.piConfig } : {};
  delete piConfig.name;
  piConfig.configDir = ".pi";
  writeFileSync(
    join(runtimeDir, "package.json"),
    JSON.stringify({
      ...packageJson,
      piConfig,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeThemes(themeDir: string, assets: Pick<BinaryRuntimeAssets, "darkTheme" | "lightTheme">): void {
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(join(themeDir, "dark.json"), JSON.stringify(assets.darkTheme));
  writeFileSync(join(themeDir, "light.json"), JSON.stringify(assets.lightTheme));
}

function writeExportHtmlAssets(
  exportHtmlDir: string,
  assets: Pick<
    BinaryRuntimeAssets,
    | "exportTemplateCss"
    | "exportTemplateHtml"
    | "exportTemplateJs"
    | "exportVendorMarked"
    | "exportVendorHighlight"
  >,
): void {
  const exportVendorDir = join(exportHtmlDir, "vendor");
  mkdirSync(exportVendorDir, { recursive: true });
  writeFileSync(join(exportHtmlDir, "template.css"), assets.exportTemplateCss);
  writeFileSync(join(exportHtmlDir, "template.html"), assets.exportTemplateHtml);
  writeFileSync(join(exportHtmlDir, "template.js"), assets.exportTemplateJs);
  writeFileSync(join(exportVendorDir, "marked.min.js"), assets.exportVendorMarked);
  writeFileSync(join(exportVendorDir, "highlight.min.js"), assets.exportVendorHighlight);
}

function writeInteractiveAssets(assetsDir: string, assetPathsByName: Record<string, string>): void {
  mkdirSync(assetsDir, { recursive: true });
  for (const [name, assetPath] of Object.entries(assetPathsByName)) {
    writeFileSync(join(assetsDir, name), readFileSync(assetPath));
  }
}

function writePhotonWasm(runtimeDir: string, photonWasmPath: string): void {
  writeFileSync(join(runtimeDir, "photon_rs_bg.wasm"), readFileSync(photonWasmPath));
}

function writeBuiltinPackages(
  runtimeDir: string,
  packages: Record<string, Record<string, string>>,
): void {
  for (const [name, files] of Object.entries(packages)) {
    const pkgDir = join(runtimeDir, "packages", name);
    mkdirSync(pkgDir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      // filename may contain subdirectories (e.g. "state/store.ts" for
      // multi-file packages); ensure the parent directory exists first.
      const filePath = join(pkgDir, filename);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
  }
}

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BinaryRuntimeAssets {
  darkTheme: unknown;
  lightTheme: unknown;
  exportTemplateCss: string;
  exportTemplateHtml: string;
  exportTemplateJs: string;
  exportVendorMarked: string;
  exportVendorHighlight: string;
  packageJson: Record<string, unknown>;
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
  for (const assetsDir of assetsDirs) mkdirSync(assetsDir, { recursive: true });
}

function writePackageJson(runtimeDir: string, packageJson: Record<string, unknown>): void {
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

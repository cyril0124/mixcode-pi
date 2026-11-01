import * as fs from "node:fs/promises";
import * as path from "node:path";

interface BinaryRuntimeAssets {
  auroraTheme: unknown;
  darkTheme: unknown;
  lightTheme: unknown;
  exportTemplateCss: string;
  exportTemplateHtml: string;
  exportTemplateJs: string;
  exportVendorMarked: string;
  exportVendorMarkedCjk: string;
  exportVendorHighlight: string;
  interactiveAssets?: Record<string, string>;
  photonWasmPath?: string;
  /** Native Pi TUI helpers: paths relative to native/ mapped to embedded files. */
  nativePlatformHelpers?: Record<string, string>;
  packageJson: Record<string, unknown>;
  packageReadme: string;
  packageChangelog: string;
  forkDocs: Record<string, string>;
  codingAgentDocs: Record<string, string>;
  forkExamples: Record<string, string>;
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

  await Promise.all([
    (async () => {
      await writePackageJson(runtimeDir, assets.packageJson);
      await Bun.write(path.join(runtimeDir, "README.md"), assets.packageReadme);
      await Bun.write(path.join(runtimeDir, "CHANGELOG.md"), assets.packageChangelog);
      for (const themeDir of themeDirs) await writeThemes(themeDir, assets);
      for (const exportHtmlDir of exportHtmlDirs)
        await writeExportHtmlAssets(exportHtmlDir, assets);
      for (const assetsDir of assetsDirs) {
        await writeInteractiveAssets(assetsDir, assets.interactiveAssets ?? {});
      }
      if (assets.photonWasmPath) await writePhotonWasm(runtimeDir, assets.photonWasmPath);
      await writeInteractiveAssets(
        path.join(runtimeDir, "native"),
        assets.nativePlatformHelpers ?? {},
      );
      if (assets.builtinPackages) await writeBuiltinPackages(runtimeDir, assets.builtinPackages);
    })(),
    (async () => {
      await writeInteractiveAssets(path.join(runtimeDir, "docs"), assets.codingAgentDocs, true);
      for (const [name, content] of Object.entries(assets.forkDocs)) {
        await Bun.write(path.join(runtimeDir, "docs", name), content);
      }
      await writeOriginalCodingAgentDocs(runtimeDir, assets.codingAgentDocs, assets.forkDocs);
    })(),
    writeInteractiveAssets(path.join(runtimeDir, "examples"), assets.forkExamples, true),
  ]);
}

/**
 * Install MixCode's own docs into `<agentDir>/mixcode-docs`, the stable location
 * `findMixcodeDocsPath` falls back to when no source tree is reachable.
 *
 * Deliberately not written under the per-process runtime dir: that directory is
 * recreated per launch and leaks on SIGKILL. Sibling of `<agentDir>/extensions`,
 * it overwrites on every compiled launch and never deletes files that
 * disappeared upstream. Concurrent launches may write the same paths; contents
 * are byte-identical, so interleaving is harmless.
 */
export async function installMixcodeDocs(
  agentDir: string,
  files: Record<string, string>,
): Promise<void> {
  const docsDir = path.join(agentDir, "mixcode-docs");
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(path.join(docsDir, name), content);
  }
}

async function writePackageJson(
  runtimeDir: string,
  packageJson: Record<string, unknown>,
): Promise<void> {
  // Preserve the fork package identity: piConfig.name selects the installed mpi host.
  await Bun.write(path.join(runtimeDir, "package.json"), JSON.stringify(packageJson));
}

async function writeThemes(
  themeDir: string,
  assets: Pick<BinaryRuntimeAssets, "auroraTheme" | "darkTheme" | "lightTheme">,
): Promise<void> {
  await Bun.write(path.join(themeDir, "aurora.json"), JSON.stringify(assets.auroraTheme));
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
    | "exportVendorMarkedCjk"
    | "exportVendorHighlight"
  >,
): Promise<void> {
  const exportVendorDir = path.join(exportHtmlDir, "vendor");
  await Bun.write(path.join(exportHtmlDir, "template.css"), assets.exportTemplateCss);
  await Bun.write(path.join(exportHtmlDir, "template.html"), assets.exportTemplateHtml);
  await Bun.write(path.join(exportHtmlDir, "template.js"), assets.exportTemplateJs);
  await Bun.write(path.join(exportVendorDir, "marked.min.js"), assets.exportVendorMarked);
  await Bun.write(
    path.join(exportVendorDir, "marked-cjk-friendly.min.js"),
    assets.exportVendorMarkedCjk,
  );
  await Bun.write(path.join(exportVendorDir, "highlight.min.js"), assets.exportVendorHighlight);
}

async function writeInteractiveAssets(
  assetsDir: string,
  assetPathsByName: Record<string, string>,
  concurrent = false,
): Promise<void> {
  if (concurrent) {
    await Promise.all(
      Object.entries(assetPathsByName).map(([name, assetPath]) =>
        Bun.write(path.join(assetsDir, name), Bun.file(assetPath)),
      ),
    );
    return;
  }
  for (const [name, assetPath] of Object.entries(assetPathsByName)) {
    await Bun.write(path.join(assetsDir, name), Bun.file(assetPath));
  }
}

/** Preserve source-tree doc links without duplicating non-overridden document bytes. */
async function writeOriginalCodingAgentDocs(
  runtimeDir: string,
  sourceFiles: Record<string, string>,
  forkDocs: Record<string, string>,
): Promise<void> {
  const docsDir = path.join(runtimeDir, "packages", "coding-agent", "docs");
  const files = Object.entries(sourceFiles);
  const parentDirs = new Set(files.map(([name]) => path.dirname(path.join(docsDir, name))));
  await Promise.all([...parentDirs].map((directory) => fs.mkdir(directory, { recursive: true })));
  await Promise.all(
    files.map(async ([name, sourcePath]) => {
      const target = path.join(docsDir, name);
      if (Object.hasOwn(forkDocs, name)) {
        await Bun.write(target, Bun.file(sourcePath));
        return;
      }
      try {
        await fs.link(path.join(runtimeDir, "docs", name), target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code ?? "")) {
          throw error;
        }
        // Some cache filesystems reject hardlinks; keep the original path readable.
        await Bun.write(target, Bun.file(sourcePath));
      }
    }),
  );
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

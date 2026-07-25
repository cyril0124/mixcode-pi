import os from "node:os";
import path from "node:path";
import type { ResourceDiagnostic, Skill, SourceInfo } from "@earendil-works/pi-coding-agent";
import type { ExtensionManagerEntry } from "../core/extension-manager.js";
import { displayToolOwner } from "../core/extension-tool-owners.js";
import {
  extensionConflictDiagnosticLines,
  extensionLoadErrorLines,
} from "./runtime-extension-ui.js";
import { getExtensionManagerEntriesForServices } from "./runtime-session.js";
import type { RuntimeTab } from "./runtime-types.js";
import { PI_BUILTIN_TOOL_NAMES } from "./tools.js";

/**
 * Recompute the tab-level startup header ([Context]/[Skills]/[Extensions]/
 * [Tool Owners]/[Skill conflicts]/[Diagnostics]) from the current services and
 * extensions. Called on every session-binding change (create/clear/fork/resume/
 * switch/reload/workdir change) so the header always reflects the live session —
 * mirroring Pi, whose loadedResourcesContainer is refreshed on session_start and
 * /reload but never cleared by chat rebuilds.
 */
export function refreshStartupHeader(runtimeTab: RuntimeTab): void {
  const contextFiles = runtimeTab.services.resourceLoader
    .getAgentsFiles()
    .agentsFiles.map((file) => displayResourcePath(file.path));
  const skillsResult = runtimeTab.services.resourceLoader.getSkills();
  const skills = skillsResult.skills.map((skill) => skill.name);
  // Re-read via services so package sourceInfo is synced after Pi's post-override
  // applyExtensionSourceInfo (entries captured in extensionsOverride are stale).
  runtimeTab.extensionManagerEntries = getExtensionManagerEntriesForServices(runtimeTab.services);
  const extensions = formatExtensionSummaries(
    runtimeTab.extensionManagerEntries.filter((entry) => entry.enabled),
  );
  const diagnostics = [
    ...extensionLoadErrorLines(runtimeTab),
    ...extensionConflictDiagnosticLines(runtimeTab, runtimeTab.extensionToolOwnerPolicy),
  ];
  const skillConflicts = skillConflictSection(skillsResult.skills, skillsResult.diagnostics);
  const leadingSections = [
    ...resourceSummarySection("Context", contextFiles),
    ...resourceSummarySection("Skills", skills),
  ];
  const trailingSections = [
    ...resourceSummarySection("Tool Owners", toolOwnerSummary(runtimeTab)),
    // Skill/Diagnostics sections only when present — empty sections add noise.
    ...skillConflicts,
    ...(diagnostics.length ? resourceSummarySection("Diagnostics", diagnostics) : []),
  ];
  runtimeTab.tab.startupSummaryCompact = [
    ...leadingSections,
    ...resourceSummarySection("Extensions", extensions.compact),
    ...trailingSections,
  ]
    .join("\n")
    .trimEnd();
  runtimeTab.tab.startupSummary = [
    ...leadingSections,
    ...resourceSummaryLinesSection("Extensions", extensions.expanded),
    ...trailingSections,
  ]
    .join("\n")
    .trimEnd();
}

function resourceSummarySection(title: string, items: string[]): string[] {
  return [`[${title}]`, items.length ? `  ${items.join(", ")}` : "  none", ""];
}

function resourceSummaryLinesSection(title: string, lines: string[]): string[] {
  return [`[${title}]`, ...(lines.length ? lines : ["  none"]), ""];
}

/**
 * Build the [Skill conflicts] section (empty when there are no skill
 * diagnostics). Mirrors Pi's InteractiveMode.formatDiagnostics: collisions are
 * grouped by name with the winner shown once and each loser marked skipped;
 * other warnings/errors follow with their source-qualified path and message.
 */
function skillConflictSection(skills: Skill[], diagnostics: ResourceDiagnostic[]): string[] {
  if (diagnostics.length === 0) return [];
  const sourceInfos = new Map<string, SourceInfo>();
  for (const skill of skills) {
    if (skill.sourceInfo) sourceInfos.set(skill.filePath, skill.sourceInfo);
  }
  const lines = formatSkillDiagnostics(diagnostics, sourceInfos);
  if (lines.length === 0) return [];
  return ["[Skill conflicts]", ...lines, ""];
}

function formatSkillDiagnostics(
  diagnostics: ResourceDiagnostic[],
  sourceInfos: Map<string, SourceInfo>,
): string[] {
  const lines: string[] = [];
  const collisions = new Map<string, ResourceDiagnostic[]>();
  const others: ResourceDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.type === "collision" && diagnostic.collision) {
      const list = collisions.get(diagnostic.collision.name) ?? [];
      list.push(diagnostic);
      collisions.set(diagnostic.collision.name, list);
    } else {
      others.push(diagnostic);
    }
  }
  for (const [name, collisionList] of collisions) {
    const first = collisionList[0]?.collision;
    if (!first) continue;
    lines.push(`  "${name}" collision:`);
    lines.push(
      `    ✓ ${formatPathWithSource(first.winnerPath, findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
    );
    for (const diagnostic of collisionList) {
      if (!diagnostic.collision) continue;
      const loserPath = diagnostic.collision.loserPath;
      lines.push(
        `    ✗ ${formatPathWithSource(loserPath, findSourceInfoForPath(loserPath, sourceInfos))} (skipped)`,
      );
    }
  }
  for (const diagnostic of others) {
    if (diagnostic.path) {
      lines.push(
        `  ${formatPathWithSource(diagnostic.path, findSourceInfoForPath(diagnostic.path, sourceInfos))}`,
      );
      lines.push(`    ${diagnostic.message}`);
    } else {
      lines.push(`  ${diagnostic.message}`);
    }
  }
  return lines;
}

/** Match a resource path to a loaded skill's source info, walking up parents. */
function findSourceInfoForPath(
  target: string,
  sourceInfos: Map<string, SourceInfo>,
): SourceInfo | undefined {
  const exact = sourceInfos.get(target);
  if (exact) return exact;
  let current = target;
  while (current.includes("/")) {
    current = current.slice(0, current.lastIndexOf("/"));
    const parent = sourceInfos.get(current);
    if (parent) return parent;
  }
  return undefined;
}

function formatPathWithSource(resourcePath: string, sourceInfo: SourceInfo | undefined): string {
  if (!sourceInfo) return formatDisplayPath(resourcePath);
  const shortPath = getShortPath(resourcePath, sourceInfo);
  const { label, scopeLabel } = getDisplaySourceInfo(sourceInfo);
  const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
  return `${labelText} ${shortPath}`;
}

function getDisplaySourceInfo(sourceInfo: SourceInfo | undefined): {
  label: string;
  scopeLabel?: string;
} {
  const source = sourceInfo?.source ?? "local";
  const scope = sourceInfo?.scope ?? "project";
  if (source === "local") {
    if (scope === "user") return { label: "user" };
    if (scope === "project") return { label: "project" };
    if (scope === "temporary") return { label: "path", scopeLabel: "temp" };
    return { label: "path" };
  }
  if (source === "cli") {
    return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined };
  }
  const scopeLabel =
    scope === "user"
      ? "user"
      : scope === "project"
        ? "project"
        : scope === "temporary"
          ? "temp"
          : undefined;
  return { label: source, scopeLabel };
}

function isPackageSource(sourceInfo: SourceInfo | undefined): boolean {
  const source = sourceInfo?.source ?? "";
  return source.startsWith("npm:") || source.startsWith("git:");
}

/** Shorten a package-relative path for display, mirroring Pi's getShortPath. */
function getShortPath(fullPath: string, sourceInfo: SourceInfo | undefined): string {
  const baseDir = sourceInfo?.baseDir;
  if (baseDir && isPackageSource(sourceInfo)) {
    const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
    if (
      relativePath &&
      relativePath !== "." &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath)
    ) {
      return relativePath.replace(/\\/g, "/");
    }
  }
  const source = sourceInfo?.source ?? "";
  const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
  if (npmMatch && source.startsWith("npm:")) return npmMatch[2];
  const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
  if (gitMatch && source.startsWith("git:")) return gitMatch[1];
  return formatDisplayPath(fullPath);
}

type ExtensionDisplayEntry = Pick<
  ExtensionManagerEntry,
  "path" | "source" | "scope" | "origin" | "baseDir"
>;

type ExtensionScope = "user" | "project" | "path";

type ExtensionScopeGroup = {
  scope: ExtensionScope;
  paths: ExtensionDisplayEntry[];
  packages: Map<string, ExtensionDisplayEntry[]>;
};

/** Pi InteractiveMode-compatible compact and expanded extension resource labels. */
export function formatExtensionSummaries(entries: readonly ExtensionDisplayEntry[]): {
  compact: string[];
  expanded: string[];
} {
  const listed = [...entries];
  return {
    compact: compactExtensionLabels(listed).sort((left, right) => left.localeCompare(right)),
    expanded: formatExtensionScopeGroups(buildExtensionScopeGroups(listed)),
  };
}

function formatExtensionDisplayPath(resourcePath: string): string {
  return formatDisplayPath(resourcePath)
    .replace(/\/index\.ts$/, "")
    .replace(/\/index\.js$/, "");
}

function isPackageExtension(entry: ExtensionDisplayEntry): boolean {
  return entry.source.startsWith("npm:") || entry.source.startsWith("git:");
}

function getExtensionShortPath(entry: ExtensionDisplayEntry): string {
  const normalizedFullPath = entry.path.replace(/\\/g, "/");
  const baseDir = entry.baseDir;
  const normalizedBaseDir = baseDir?.replace(/\\/g, "/");
  if (baseDir && normalizedBaseDir && isPackageExtension(entry)) {
    const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
    if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
      return path.posix.relative(normalizedBaseDir, normalizedFullPath);
    }
    const relativePath = path.relative(path.resolve(baseDir), path.resolve(entry.path));
    if (
      relativePath &&
      relativePath !== "." &&
      !relativePath.startsWith("..") &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    ) {
      return relativePath.replace(/\\/g, "/");
    }
  }
  const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
  if (npmMatch && entry.source.startsWith("npm:")) return npmMatch[2];
  const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
  if (gitMatch && entry.source.startsWith("git:")) return gitMatch[1];
  return formatDisplayPath(entry.path);
}

function compactPackageSourceLabel(source: string): string {
  if (source.startsWith("npm:")) return source.slice("npm:".length) || source;
  if (!source.startsWith("git:")) return source;
  return source
    .slice("git:".length)
    .trim()
    .replace(/^git@[^:]+:/, "")
    .replace(/^(?:https?|ssh|git):\/\/[^/]+\//, "")
    .replace(/^[^/]+\/(?=[^/]+\/)/, "")
    .replace(/#.*$/, "")
    .replace(/\.git$/, "");
}

function compactPackageExtensionLabel(entry: ExtensionDisplayEntry): string {
  const sourceLabel = compactPackageSourceLabel(entry.source);
  if (!sourceLabel) return compactPathLabel(entry.path);
  const shortPath = getExtensionShortPath(entry);
  const packagePath = shortPath.startsWith("extensions/")
    ? shortPath.slice("extensions/".length)
    : shortPath;
  const parsedPath = path.posix.parse(packagePath);
  if (parsedPath.name === "index") {
    return !parsedPath.dir || parsedPath.dir === "."
      ? sourceLabel
      : `${sourceLabel}:${parsedPath.dir}`;
  }
  return `${sourceLabel}:${packagePath}`;
}

function compactPathSegments(resourcePath: string): string[] {
  return formatDisplayPath(resourcePath)
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "~");
}

function compactPathLabel(resourcePath: string): string {
  const segments = compactPathSegments(resourcePath);
  return segments.at(-1) ?? formatDisplayPath(resourcePath);
}

function compactExtensionLabels(entries: ExtensionDisplayEntry[]): string[] {
  const nonPackageEntries = entries
    .filter((entry) => !isPackageExtension(entry))
    .map((entry) => {
      const segments = compactPathSegments(entry.path);
      const last = segments.at(-1);
      if (segments.length > 1 && (last === "index.ts" || last === "index.js")) segments.pop();
      return { entry, segments };
    });
  return entries.map((entry) => {
    if (isPackageExtension(entry)) return compactPackageExtensionLabel(entry);
    const index = nonPackageEntries.findIndex((item) => item.entry.path === entry.path);
    const segments = nonPackageEntries[index]?.segments;
    if (!segments?.length) return compactPathLabel(entry.path);
    for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
      const candidate = segments.slice(-segmentCount).join("/");
      const unique = nonPackageEntries.every(
        (item, itemIndex) =>
          itemIndex === index || item.segments.slice(-segmentCount).join("/") !== candidate,
      );
      if (unique) return candidate;
    }
    return segments.join("/");
  });
}

function extensionScope(entry: ExtensionDisplayEntry): ExtensionScope {
  if (entry.source === "cli" || entry.scope === "temporary") return "path";
  if (entry.scope === "user") return "user";
  if (entry.scope === "project") return "project";
  return "path";
}

function buildExtensionScopeGroups(entries: ExtensionDisplayEntry[]): ExtensionScopeGroup[] {
  const groups: Record<ExtensionScope, ExtensionScopeGroup> = {
    user: { scope: "user", paths: [], packages: new Map() },
    project: { scope: "project", paths: [], packages: new Map() },
    path: { scope: "path", paths: [], packages: new Map() },
  };
  for (const entry of entries) {
    const group = groups[extensionScope(entry)];
    if (isPackageExtension(entry)) {
      const items = group.packages.get(entry.source) ?? [];
      items.push(entry);
      group.packages.set(entry.source, items);
    } else {
      group.paths.push(entry);
    }
  }
  return [groups.project, groups.user, groups.path].filter(
    (group) => group.paths.length > 0 || group.packages.size > 0,
  );
}

function formatExtensionScopeGroups(groups: ExtensionScopeGroup[]): string[] {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`  ${group.scope}`);
    for (const entry of [...group.paths].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      lines.push(`    ${formatExtensionDisplayPath(entry.path)}`);
    }
    for (const [source, entries] of [...group.packages.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`    ${source}`);
      for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
        lines.push(`      ${formatExtensionDisplayPath(getExtensionShortPath(entry))}`);
      }
    }
  }
  return lines;
}

function displayResourcePath(resourcePath: string): string {
  const home = process.env.HOME;
  return home && resourcePath.startsWith(`${home}/`)
    ? `~/${resourcePath.slice(home.length + 1)}`
    : resourcePath;
}

/** Replace the home directory prefix with `~`, matching Pi's formatDisplayPath. */
function formatDisplayPath(resourcePath: string): string {
  const home = os.homedir();
  return resourcePath.startsWith(home) ? `~${resourcePath.slice(home.length)}` : resourcePath;
}

function toolOwnerSummary(runtimeTab: RuntimeTab): string[] {
  const builtInToolNames = new Set<string>(PI_BUILTIN_TOOL_NAMES);
  return runtimeTab.agentSession
    .getAllTools()
    .filter((tool) => builtInToolNames.has(tool.name) && tool.sourceInfo?.source !== "builtin")
    .map((tool) => `${tool.name} -> ${displayToolOwner(tool.sourceInfo)}`)
    .sort((left, right) => left.localeCompare(right));
}

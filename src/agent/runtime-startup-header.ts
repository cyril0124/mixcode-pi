import os from "node:os";
import path from "node:path";
import type { ResourceDiagnostic, Skill, SourceInfo } from "@earendil-works/pi-coding-agent";
import type { ExtensionManagerEntry } from "../core/extension-manager.js";
import { displayToolOwner } from "../core/extension-tool-owners.js";
import {
  extensionConflictDiagnosticLines,
  extensionLoadErrorLines,
} from "./runtime-extension-ui.js";
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
  const extensions = runtimeTab.extensionManagerEntries
    .filter((entry) => entry.enabled)
    .map((entry) => displayExtensionName(entry));
  const diagnostics = [
    ...extensionLoadErrorLines(runtimeTab),
    ...extensionConflictDiagnosticLines(runtimeTab, runtimeTab.extensionToolOwnerPolicy),
  ];
  const skillConflicts = skillConflictSection(skillsResult.skills, skillsResult.diagnostics);
  runtimeTab.tab.startupSummary = [
    ...resourceSummarySection("Context", contextFiles),
    ...resourceSummarySection("Skills", skills),
    ...resourceSummarySection("Extensions", extensions),
    ...resourceSummarySection("Tool Owners", toolOwnerSummary(runtimeTab)),
    // Skill/Diagnostics sections only when present — empty sections add noise.
    ...skillConflicts,
    ...(diagnostics.length ? resourceSummarySection("Diagnostics", diagnostics) : []),
  ]
    .join("\n")
    .trimEnd();
}

function resourceSummarySection(title: string, items: string[]): string[] {
  return [`[${title}]`, items.length ? `  ${items.join(", ")}` : "  none", ""];
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

function displayExtensionName(entry: ExtensionManagerEntry): string {
  if (entry.source && entry.source !== "local" && entry.source !== "unknown") return entry.source;
  return displayResourcePath(entry.path);
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

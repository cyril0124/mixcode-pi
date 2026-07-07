import path from "node:path";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  SlashCommand,
} from "@earendil-works/pi-tui";
import { LOCAL_COMMANDS } from "../core/commands.js";
import { fdFileSuggestions } from "../core/fd-file-search.js";
import { searchProjectFiles } from "../core/file-picker.js";

export interface MixCodeCompletionSourceInfo {
  source?: string;
  path?: string;
}

export type MixCodeCompletionCommand = Pick<
  SlashCommand,
  "name" | "description" | "argumentHint" | "getArgumentCompletions"
> & {
  sourceInfo?: MixCodeCompletionSourceInfo;
};
type SourcedCompletionCommand = MixCodeCompletionCommand & { source: "built-in" | "extension" };
export interface MixCodeSkillSourceInfo {
  scope?: "user" | "project" | "temporary";
  source?: string;
}

export interface MixCodeSkillCompletionSource {
  name: string;
  path?: string;
  description?: string;
  sourceInfo?: MixCodeSkillSourceInfo;
}

export interface MixCodePromptTemplateCompletionSource {
  name: string;
  description?: string;
  argumentHint?: string;
  sourceInfo?: MixCodeSkillSourceInfo;
}

export interface MixCodeCompletionSources {
  skills:
    | Array<string | MixCodeSkillCompletionSource>
    | (() => Array<string | MixCodeSkillCompletionSource>);
  files: string[] | (() => string[] | Promise<string[]>);
  commands?: MixCodeCompletionCommand[] | (() => MixCodeCompletionCommand[]);
  promptTemplates?:
    | MixCodePromptTemplateCompletionSource[]
    | (() => MixCodePromptTemplateCompletionSource[]);
  /**
   * Live `@` file completion via fd, matching pi's behavior. When this returns
   * an fd binary name and a workdir, `@` queries shell out to fd instead of
   * fuzzy-matching the static `files` snapshot. Returning undefined (no fd
   * installed) falls back to the static `files` list.
   */
  fileSearch?: () => { fdPath: string; workdir: string } | undefined;
}

export class MixCodeCompletionProvider implements AutocompleteProvider {
  constructor(private readonly sources: MixCodeCompletionSources) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options?: { signal?: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol);
    const token = currentToken(before);
    const skills = resolveCompletionSkills(this.sources.skills);
    const commands = mergedSlashCommands(this.sources.commands, skills, resolvePromptTemplates(this.sources.promptTemplates));
    if (token.startsWith("/") && isSlashCommandNameContext(before, token)) {
      const prefix = token.slice(1);
      // Keep the menu open even when the typed name exactly matches a command
      // (pi parity). Closing it here strands the picker: the base Editor only
      // re-triggers autocomplete on `/`, trigger chars, or word chars — never a
      // space — so a closed menu can't reopen for `/<cmd> ` argument hints.
      const matchedCommands = fuzzyFilter(commands, prefix, (command) => command.name);
      if (matchedCommands.length === 0) return null;
      return {
        prefix: token,
        items: matchedCommands.map((command) => ({
          value: `/${command.name}`,
          label: commandLabel(command),
          description: commandDescription(command),
        })),
      };
    }
    if (token.startsWith("@")) {
      const prefix = token.slice(1);
      const isQuoted = prefix.startsWith('"');
      const query = isQuoted ? prefix.slice(1) : prefix;
      const fileSearch = this.sources.fileSearch?.();
      // Prefer live fd search (pi parity): always reflects current disk state,
      // gitignore-aware, no static-snapshot cap. Fall back to the static list
      // when fd is unavailable or the fd query yields nothing usable.
      if (fileSearch) {
        const matches = await fdFileSuggestions(query, {
          workdir: fileSearch.workdir,
          fdPath: fileSearch.fdPath,
          signal: options?.signal ?? new AbortController().signal,
        });
        if (matches.length > 0) {
          return {
            prefix: token,
            items: matches.map((match) => ({
              value: formatFileCompletionValue(match.displayPath, isQuoted),
              label: path.basename(trimTrailingSlash(match.displayPath)) + (match.isDirectory ? "/" : ""),
              description: match.displayPath,
            })),
          };
        }
      }
      const files = await resolveCompletionFiles(this.sources.files);
      return {
        prefix: token,
        items: searchProjectFiles(query, files).map((file) => ({
          value: formatFileCompletionValue(file, isQuoted),
          label: file,
        })),
      };
    }
    const slashArgumentSuggestions = await getSlashArgumentSuggestions(before, commands);
    if (slashArgumentSuggestions) return slashArgumentSuggestions;
    return null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    const line = lines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;
    const nextLine = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
    const nextLines = lines.slice();
    nextLines[cursorLine] = nextLine;
    return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const token = currentToken((lines[cursorLine] ?? "").slice(0, cursorCol));
    // `$` skill completion lives in the skill-refs extension provider, which
    // wraps this one and handles its own triggering.
    return token.startsWith("@");
  }
}

function resolveCompletionSkills(
  skills: MixCodeCompletionSources["skills"],
): Array<string | MixCodeSkillCompletionSource> {
  return typeof skills === "function" ? skills() : skills;
}

function resolvePromptTemplates(
  templates: MixCodeCompletionSources["promptTemplates"],
): MixCodePromptTemplateCompletionSource[] {
  if (!templates) return [];
  return typeof templates === "function" ? templates() : templates;
}

async function resolveCompletionFiles(files: MixCodeCompletionSources["files"]): Promise<string[]> {
  return typeof files === "function" ? await files() : files;
}

function currentToken(text: string): string {
  const match = text.match(/(?:^|\s)([/$@][^\s"]*|@"[^"]*)$/);
  return match?.[1] ?? "";
}

function skillCompletionSources(
  skills: Array<string | MixCodeSkillCompletionSource>,
): MixCodeSkillCompletionSource[] {
  return skills.map((skill) => (typeof skill === "string" ? { name: skill } : skill));
}

/**
 * Format skill description for /skill: slash commands with a source scope tag prefix.
 * Matches the Pi reference `prefixAutocompleteDescription` + `getAutocompleteSourceTag` pattern.
 * Examples: "[u] Description", "[p:npm:@foo/bar] Description"
 */
function prefixSkillDescription(
  description: string | undefined,
  sourceInfo: MixCodeSkillSourceInfo | undefined,
): string {
  const sourceTag = getSkillSourceTag(sourceInfo);
  const desc = description ? compactSkillSummary(description) : undefined;
  if (!sourceTag) return desc ?? "Invoke skill";
  return desc ? `[${sourceTag}] ${desc}` : `[${sourceTag}]`;
}

function getSkillSourceTag(sourceInfo: MixCodeSkillSourceInfo | undefined): string | undefined {
  if (!sourceInfo) return undefined;
  const scopePrefix =
    sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
  const source = sourceInfo.source?.trim();
  if (!source || source === "auto" || source === "local" || source === "cli") return scopePrefix;
  if (source.startsWith("npm:")) return `${scopePrefix}:${source}`;
  return scopePrefix;
}

function compactSkillSummary(value: string | undefined): string {
  if (!value) return "";
  const plain = value
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}>+\s?/u, "")
        .replace(/^\s{0,3}#{1,6}\s+/u, "")
        .replace(/^\s*[-*+]\s+/u, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  if (plain.length <= 96) return plain;
  return `${plain.slice(0, 95).trimEnd()}…`;
}

function isSlashCommandNameContext(before: string, token: string): boolean {
  return before.trimStart() === token;
}

async function getSlashArgumentSuggestions(
  before: string,
  commands: MixCodeCompletionCommand[],
): Promise<AutocompleteSuggestions | null> {
  const trimmed = before.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) return null;
  const commandName = trimmed.slice(1, spaceIndex);
  const command = commands.find((item) => item.name === commandName);
  if (!command?.getArgumentCompletions) return null;
  const argumentText = trimmed.slice(spaceIndex + 1);
  const items = await command.getArgumentCompletions(argumentText);
  if (!Array.isArray(items) || items.length === 0) return null;
  if (commandName === "theme") {
    return {
      prefix: trimmed,
      items: items.map((item) => ({
        ...item,
        value: `/theme ${item.value}`,
      })),
    };
  }
  return { prefix: argumentText, items };
}

function formatFileCompletionValue(path: string, forceQuote = false): string {
  if (!forceQuote && !/[\s"]/.test(path)) return `@${path}`;
  return `@"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function trimTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function commandLabel(command: SourcedCompletionCommand): string {
  return `${command.name} (${commandSourceLabel(command)})`;
}

function commandDescription(command: SourcedCompletionCommand): string {
  if (!command.argumentHint) return command.description ?? "";
  return command.description
    ? `${command.argumentHint} - ${command.description}`
    : command.argumentHint;
}

function commandSourceLabel(command: SourcedCompletionCommand): string {
  if (command.source === "built-in") return "built-in";
  return `ext:${extensionSourceName(command.sourceInfo)}`;
}

function canAugmentBuiltInCommand(name: string): boolean {
  return name === "restore-workspace" || name === "delete-workspace";
}

function extensionSourceName(sourceInfo: MixCodeCompletionSourceInfo | undefined): string {
  if (sourceInfo?.source) return formatExtensionSourceName(sourceInfo.source);
  if (sourceInfo?.path) {
    const basename = path.basename(sourceInfo.path, path.extname(sourceInfo.path));
    if (basename) return basename;
  }
  return "extension";
}

function formatExtensionSourceName(source: string): string {
  if (!source.startsWith("npm:")) return source;
  const packageSpec = source.slice("npm:".length);
  if (packageSpec.startsWith("@")) {
    const versionSeparator = packageSpec.indexOf("@", packageSpec.indexOf("/") + 1);
    return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
  }
  const versionSeparator = packageSpec.lastIndexOf("@");
  return versionSeparator <= 0 ? packageSpec : packageSpec.slice(0, versionSeparator);
}

function mergedSlashCommands(
  extensionCommands: MixCodeCompletionSources["commands"] = [],
  skills: Array<string | MixCodeSkillCompletionSource> = [],
  promptTemplates: MixCodePromptTemplateCompletionSource[] = [],
): SourcedCompletionCommand[] {
  const commands = new Map<string, SourcedCompletionCommand>();
  for (const command of LOCAL_COMMANDS)
    commands.set(command.name, { ...command, source: "built-in" });
  const resolvedExtensionCommands =
    typeof extensionCommands === "function" ? extensionCommands() : extensionCommands;
  for (const command of resolvedExtensionCommands) {
    const existing = commands.get(command.name);
    if (!existing) {
      commands.set(command.name, { ...command, source: "extension" });
      continue;
    }
    if (
      existing.source === "built-in" &&
      command.getArgumentCompletions &&
      canAugmentBuiltInCommand(command.name)
    ) {
      commands.set(command.name, {
        ...existing,
        argumentHint: command.argumentHint ?? existing.argumentHint,
        getArgumentCompletions: command.getArgumentCompletions,
      });
    }
  }
  // Register prompt templates as slash commands (matches Pi reference behavior)
  for (const template of promptTemplates) {
    if (!commands.has(template.name)) {
      commands.set(template.name, {
        name: template.name,
        description: prefixSkillDescription(template.description, template.sourceInfo),
        argumentHint: template.argumentHint,
        source: "built-in",
      });
    }
  }
  // Register skills as /skill:<name> commands (matches Pi reference behavior)
  for (const skill of skillCompletionSources(skills)) {
    const commandName = `skill:${skill.name}`;
    if (!commands.has(commandName)) {
      commands.set(commandName, {
        name: commandName,
        description: prefixSkillDescription(skill.description, skill.sourceInfo),
        source: "built-in",
      });
    }
  }
  return [...commands.values()];
}

import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { LOCAL_COMMANDS } from "../../core/commands.js";

export type MixCodeCompletionCommand = Pick<
  SlashCommand,
  "name" | "description" | "argumentHint" | "getArgumentCompletions"
>;

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
  commands?: MixCodeCompletionCommand[] | (() => MixCodeCompletionCommand[]);
  promptTemplates?:
    | MixCodePromptTemplateCompletionSource[]
    | (() => MixCodePromptTemplateCompletionSource[]);
  workdir?: string | (() => string);
  fdPath?: string;
}

/**
 * Builds Pi's native provider from MixCode's active-tab sources. Rebuilding for
 * each query keeps extension commands, resources, and workdir changes live.
 */
export class MixCodeCompletionProvider implements AutocompleteProvider {
  private readonly completionDelegate = new CombinedAutocompleteProvider([], process.cwd());

  constructor(private readonly sources: MixCodeCompletionSources) {}

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal?: AbortSignal; force?: boolean } = {},
  ): Promise<AutocompleteSuggestions | null> {
    const provider = new CombinedAutocompleteProvider(
      mergedSlashCommands(
        this.sources.commands,
        resolveCompletionSkills(this.sources.skills),
        resolvePromptTemplates(this.sources.promptTemplates),
      ),
      resolveWorkdir(this.sources.workdir),
      this.sources.fdPath,
    );
    return provider.getSuggestions(lines, cursorLine, cursorCol, {
      ...options,
      signal: options.signal ?? new AbortController().signal,
    });
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    return this.completionDelegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.completionDelegate.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
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

function resolveWorkdir(workdir: MixCodeCompletionSources["workdir"]): string {
  if (typeof workdir === "function") return workdir();
  return workdir ?? process.cwd();
}

function skillCompletionSources(
  skills: Array<string | MixCodeSkillCompletionSource>,
): MixCodeSkillCompletionSource[] {
  return skills.map((skill) => (typeof skill === "string" ? { name: skill } : skill));
}

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

function compactSkillSummary(value: string): string {
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

// Built-in commands whose argument completions come from live TUI state
// (injected via the commands source in app.ts) instead of LOCAL_COMMANDS.
const AUGMENTABLE_BUILTIN_COMMANDS = new Set([
  "restore-workspace",
  "delete-workspace",
  "models",
  "thinking",
]);

function canAugmentBuiltInCommand(name: string): boolean {
  return AUGMENTABLE_BUILTIN_COMMANDS.has(name);
}

function mergedSlashCommands(
  extensionCommands: MixCodeCompletionSources["commands"] = [],
  skills: Array<string | MixCodeSkillCompletionSource> = [],
  promptTemplates: MixCodePromptTemplateCompletionSource[] = [],
): MixCodeCompletionCommand[] {
  const commands = new Map<string, MixCodeCompletionCommand>();
  for (const command of LOCAL_COMMANDS) commands.set(command.name, command);

  const resolvedExtensionCommands =
    typeof extensionCommands === "function" ? extensionCommands() : extensionCommands;
  for (const command of resolvedExtensionCommands) {
    const existing = commands.get(command.name);
    if (!existing) {
      commands.set(command.name, command);
      continue;
    }
    if (command.getArgumentCompletions && canAugmentBuiltInCommand(command.name)) {
      commands.set(command.name, {
        ...existing,
        argumentHint: command.argumentHint ?? existing.argumentHint,
        getArgumentCompletions: command.getArgumentCompletions,
      });
    }
  }

  for (const template of promptTemplates) {
    if (!commands.has(template.name)) {
      commands.set(template.name, {
        name: template.name,
        description: prefixSkillDescription(template.description, template.sourceInfo),
        argumentHint: template.argumentHint,
      });
    }
  }

  for (const skill of skillCompletionSources(skills)) {
    const commandName = `skill:${skill.name}`;
    if (!commands.has(commandName)) {
      commands.set(commandName, {
        name: commandName,
        description: prefixSkillDescription(skill.description, skill.sourceInfo),
      });
    }
  }
  return [...commands.values()];
}

import {
  CombinedAutocompleteProvider,
  fuzzyFilter,
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

export interface MixCodeTabCompletionSource {
  title: string;
  status?: string;
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
  /** Agent tabs of the current instance, offered as @-mention completions. */
  tabs?: MixCodeTabCompletionSource[] | (() => MixCodeTabCompletionSource[]);
}

/**
 * Builds Pi's native provider from MixCode's active-tab sources. Rebuilding for
 * each query keeps extension commands, resources, and workdir changes live.
 */
export class MixCodeCompletionProvider implements AutocompleteProvider {
  private readonly completionDelegate = new CombinedAutocompleteProvider([], process.cwd());
  private readonly tabCompletionItems = new WeakSet<AutocompleteItem>();

  constructor(private readonly sources: MixCodeCompletionSources) {}

  async getSuggestions(
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
    const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, {
      ...options,
      signal: options.signal ?? new AbortController().signal,
    });
    const atPrefix = extractAtMentionPrefix((lines[cursorLine] ?? "").slice(0, cursorCol));
    if (!atPrefix) return suggestions;
    const tabItems = tabMentionItems(resolveTabs(this.sources.tabs), atPrefix);
    if (tabItems.length === 0) return suggestions;
    for (const item of tabItems) this.tabCompletionItems.add(item);
    // Pi's @ branch returns the same prefix it extracted; when it found no
    // files it returns null, so fall back to the locally extracted prefix.
    return {
      items: [...tabItems, ...(suggestions?.items ?? [])],
      prefix: suggestions?.prefix ?? atPrefix,
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    // Pi infers directories from labels; slash-ending tab titles remain mentions.
    const delegateItem =
      this.tabCompletionItems.has(item) && item.label.endsWith("/")
        ? { ...item, label: item.label.slice(0, -1) }
        : item;
    return this.completionDelegate.applyCompletion(
      lines,
      cursorLine,
      cursorCol,
      delegateItem,
      prefix,
    );
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

function resolveTabs(tabs: MixCodeCompletionSources["tabs"]): MixCodeTabCompletionSource[] {
  if (!tabs) return [];
  return typeof tabs === "function" ? tabs() : tabs;
}

// Same delimiter set as pi-tui's private @-prefix extraction.
const AT_TOKEN_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

/**
 * Extract the @-mention token before the cursor, mirroring pi-tui
 * CombinedAutocompleteProvider's private extractAtPrefix (plain `@token`
 * after a delimiter, or an unclosed `@"quoted` form). Keeping both
 * extractions in lockstep guarantees tab items replace exactly the range
 * upstream file completions replace, so one shared applyCompletion works.
 */
function extractAtMentionPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (
    quoteStart !== null &&
    quoteStart > 0 &&
    text[quoteStart - 1] === "@" &&
    (quoteStart === 1 || AT_TOKEN_DELIMITERS.has(text[quoteStart - 2] ?? ""))
  ) {
    return text.slice(quoteStart - 1);
  }
  let tokenStart = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (AT_TOKEN_DELIMITERS.has(text[i] ?? "")) {
      tokenStart = i + 1;
      break;
    }
  }
  return text[tokenStart] === "@" ? text.slice(tokenStart) : null;
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

function tabMentionItems(tabs: MixCodeTabCompletionSource[], atPrefix: string): AutocompleteItem[] {
  if (tabs.length === 0) return [];
  const isQuoted = atPrefix.startsWith('@"');
  const rawQuery = atPrefix.slice(isQuoted ? 2 : 1);
  return fuzzyFilter(tabs, rawQuery, (tab) => tab.title).map((tab) => ({
    // Quote Pi token delimiters and JSON-escape embedded quotes.
    value:
      isQuoted || [...tab.title].some((character) => AT_TOKEN_DELIMITERS.has(character))
        ? `@${JSON.stringify(tab.title)}`
        : `@${tab.title}`,
    label: tab.title,
    description: tab.status ? `[tab] ${tab.status}` : "[tab]",
  }));
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
  "login",
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

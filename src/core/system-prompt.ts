import {
  type BuildSystemPromptOptions,
  buildSystemPrompt,
} from "@earendil-works/pi-coding-agent";
import { detectSearchTools, type SearchToolAvailability } from "./detect-search-tools.js";

let globalConversationHistoryPrompt: string | undefined;

export function setGlobalConversationHistoryPrompt(prompt: string | undefined): void {
  globalConversationHistoryPrompt = prompt;
}

export const MIXCODE_SYSTEM_PROMPT =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export type MixCodeSystemPromptPartsOptions = BuildSystemPromptOptions & {
  searchTools?: SearchToolAvailability;
  conversationHistoryPrompt?: string;
};

/**
 * MixCode system prompt on top of Pi's buildSystemPrompt.
 *
 * Always passes a customPrompt so Pi never injects its default "Pi documentation"
 * block. Tools/guidelines (incl. rg/fd search rules) stay MixCode-owned because
 * Pi's customPrompt path skips them; conversation history + Current date are
 * MixCode-only and layered around Pi's append/context/skills/cwd assembly.
 */
export function buildMixCodeSystemPromptFromParts(
  options: MixCodeSystemPromptPartsOptions,
): string {
  const {
    customPrompt,
    selectedTools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    contextFiles,
    skills,
    searchTools,
    conversationHistoryPrompt = globalConversationHistoryPrompt,
  } = options;

  const identity =
    customPrompt && customPrompt !== MIXCODE_SYSTEM_PROMPT ? customPrompt : MIXCODE_SYSTEM_PROMPT;
  const toolsSection = buildToolsAndGuidelinesSection({
    selectedTools,
    toolSnippets,
    promptGuidelines,
    searchTools,
  });

  let append = appendSystemPrompt;
  if (conversationHistoryPrompt) {
    append = append ? `${append}\n\n${conversationHistoryPrompt}` : conversationHistoryPrompt;
  }

  const prompt = buildSystemPrompt({
    customPrompt: identity + toolsSection,
    selectedTools,
    appendSystemPrompt: append,
    cwd,
    contextFiles,
    skills,
  });

  // Pi ends with cwd only; MixCode also stamps the calendar date.
  return prompt.replace(
    /(\nCurrent working directory: [^\n]*)$/,
    `\nCurrent date: ${currentDate()}$1`,
  );
}

function buildToolsAndGuidelinesSection(
  options: Pick<BuildSystemPromptOptions, "selectedTools" | "toolSnippets" | "promptGuidelines"> & {
    searchTools?: SearchToolAvailability;
  },
): string {
  const { selectedTools, toolSnippets, promptGuidelines, searchTools } = options;
  const tools = selectedTools || ["read", "bash", "edit", "write"];
  const snippets = toolSnippets ?? {};
  const visibleTools = tools.filter((name) => !!snippets[name]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools.map((name) => `- ${name}: ${snippets[name]}`).join("\n")
      : "(none)";
  const guidelines = buildGuidelines(tools, promptGuidelines, searchTools)
    .map((g) => `- ${g}`)
    .join("\n");

  return `\n\nAvailable tools:\n${toolsList}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n${guidelines}`;
}

function buildGuidelines(
  tools: string[],
  promptGuidelines: string[] | undefined,
  searchTools?: SearchToolAvailability,
): string[] {
  const guidelinesList: string[] = [];
  const guidelinesSet = new Set<string>();
  const addGuideline = (guideline: string) => {
    if (guidelinesSet.has(guideline)) return;
    guidelinesSet.add(guideline);
    guidelinesList.push(guideline);
  };

  const hasBash = tools.includes("bash");
  if (hasBash) {
    const availability = searchTools ?? detectSearchTools();
    for (const g of buildSearchGuidelines(availability)) {
      addGuideline(g);
    }
  }
  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) {
      addGuideline(normalized);
    }
  }
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");
  return guidelinesList;
}

/**
 * Build search tool guidelines based on available CLI tools.
 * Only emits guidelines when rg/fd are available, to override model defaults.
 */
function buildSearchGuidelines(availability: SearchToolAvailability): string[] {
  const guidelines: string[] = [];
  if (availability.hasRg) {
    guidelines.push("For content search, ALWAYS use `rg` (ripgrep).");
  }
  if (availability.hasFd) {
    guidelines.push("For file search, ALWAYS use `fd`.");
  }
  return guidelines;
}

export function buildMixCodeSystemPromptOptionsFromSession(
  session: {
    getActiveToolNames(): string[];
    getToolDefinition(
      name: string,
    ): { promptSnippet?: string; promptGuidelines?: string[] } | undefined;
  },
  base: Omit<MixCodeSystemPromptPartsOptions, "selectedTools" | "toolSnippets" | "promptGuidelines">,
): MixCodeSystemPromptPartsOptions {
  const selectedTools = session.getActiveToolNames();
  const toolSnippets: Record<string, string> = {};
  // Collect per-tool guidelines alongside snippets. Pi's own _rebuildSystemPrompt
  // feeds both builtin (read/edit/write) and extension tool promptGuidelines into
  // the prompt; dropping them here would silently lose those usage constraints.
  const promptGuidelines: string[] = [];
  for (const name of selectedTools) {
    const definition = session.getToolDefinition(name);
    const snippet = normalizePromptSnippet(definition?.promptSnippet);
    if (snippet) {
      toolSnippets[name] = snippet;
    }
    for (const guideline of definition?.promptGuidelines ?? []) {
      promptGuidelines.push(guideline);
    }
  }
  return {
    ...base,
    selectedTools,
    toolSnippets,
    promptGuidelines,
  };
}

function normalizePromptSnippet(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const oneLine = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > 0 ? oneLine : undefined;
}

function currentDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

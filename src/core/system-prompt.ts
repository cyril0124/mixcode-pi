import {
  type BuildSystemPromptOptions,
  buildSystemPrompt,
} from "@earendil-works/pi-coding-agent";

export interface SearchToolAvailability {
  /** Whether `rg` (ripgrep) is available on PATH. */
  hasRg: boolean;
  /** Whether `fd` (fd-find) is available on PATH. */
  hasFd: boolean;
}

/** Detect whether rg and fd are on PATH. */
export function detectSearchTools(): SearchToolAvailability {
  return {
    hasRg: Boolean(Bun.which("rg")),
    hasFd: Boolean(Bun.which("fd")),
  };
}

let globalConversationHistoryPrompt: string | undefined;

export function setGlobalConversationHistoryPrompt(prompt: string | undefined): void {
  globalConversationHistoryPrompt = prompt;
}

export const MIXCODE_SYSTEM_PROMPT =
  "You are an expert coding assistant operating inside MixCode (`mpi`), a Pi-compatible terminal coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

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
    // Pi's conditional: bash covers file ops when no dedicated grep/find/ls tools.
    if (!tools.includes("grep") && !tools.includes("find") && !tools.includes("ls")) {
      addGuideline("Use bash for file operations like ls, rg, find");
    }
  }
  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) {
      addGuideline(normalized);
    }
  }
  // Re-state the builtin read/write constraints explicitly so they hold even if
  // Pi's promptGuidelines forwarding ever drops them.
  if (tools.includes("read")) {
    addGuideline("Use read to examine files instead of cat or sed.");
  }
  if (tools.includes("write")) {
    addGuideline("Use write only for new files or complete rewrites.");
  }
  if (tools.includes("edit")) {
    addGuideline(
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    );
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

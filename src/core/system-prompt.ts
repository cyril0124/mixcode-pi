import {
  type BuildSystemPromptOptions,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

export const MIXCODE_SYSTEM_PROMPT =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export interface BuildMixCodeSystemPromptOptions {
  workdir: string;
  basePrompt?: string;
  agentDir?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
}

export async function buildMixCodeSystemPrompt(
  options: BuildMixCodeSystemPromptOptions,
): Promise<string> {
  const agentDir = options.agentDir ?? getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: options.workdir,
    agentDir,
    systemPromptOverride: (base) => base ?? options.basePrompt,
  });
  await loader.reload();

  return buildMixCodeSystemPromptFromParts({
    customPrompt: loader.getSystemPrompt() || undefined,
    selectedTools: options.selectedTools,
    toolSnippets: options.toolSnippets,
    promptGuidelines: options.promptGuidelines,
    appendSystemPrompt: loader.getAppendSystemPrompt().join("\n\n"),
    contextFiles: loader.getAgentsFiles().agentsFiles,
    skills: loader.getSkills().skills,
    cwd: options.workdir,
  });
}

export function buildMixCodeSystemPromptFromParts(options: BuildSystemPromptOptions): string {
  const {
    customPrompt,
    selectedTools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    contextFiles: providedContextFiles,
    skills: providedSkills,
  } = options;
  const promptCwd = cwd.replace(/\\/g, "/");
  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
  const contextFiles = providedContextFiles ?? [];
  const skills = providedSkills ?? [];

  let prompt =
    customPrompt && customPrompt !== MIXCODE_SYSTEM_PROMPT
      ? customPrompt
      : buildDefaultMixCodePrompt({ selectedTools, toolSnippets, promptGuidelines });
  if (appendSection) {
    prompt += appendSection;
  }
  const projectContext = formatProjectContext(contextFiles);
  if (projectContext) {
    prompt += `\n\n${projectContext}`;
  }
  const hasRead = !selectedTools || selectedTools.includes("read");
  if (hasRead && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }
  prompt += `\nCurrent date: ${currentDate()}`;
  prompt += `\nCurrent working directory: ${promptCwd}`;
  return prompt;
}

function buildDefaultMixCodePrompt(
  options: Pick<BuildSystemPromptOptions, "selectedTools" | "toolSnippets" | "promptGuidelines">,
): string {
  const { selectedTools, toolSnippets, promptGuidelines } = options;
  const tools = selectedTools || ["read", "bash", "edit", "write"];
  const snippets = toolSnippets ?? {};
  const visibleTools = tools.filter((name) => !!snippets[name]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools.map((name) => `- ${name}: ${snippets[name]}`).join("\n")
      : "(none)";
  const guidelines = buildGuidelines(tools, promptGuidelines)
    .map((g) => `- ${g}`)
    .join("\n");

  return `${MIXCODE_SYSTEM_PROMPT}

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}`;
}

function buildGuidelines(tools: string[], promptGuidelines: string[] | undefined): string[] {
  const guidelinesList: string[] = [];
  const guidelinesSet = new Set<string>();
  const addGuideline = (guideline: string) => {
    if (guidelinesSet.has(guideline)) return;
    guidelinesSet.add(guideline);
    guidelinesList.push(guideline);
  };

  const hasBash = tools.includes("bash");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");
  const hasLs = tools.includes("ls");
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
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

function formatProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
  if (contextFiles.length === 0) return "";
  const contextFileSections = contextFiles.map(
    ({ path, content }) =>
      `  <context_file>\n    <path>${path}</path>\n    <content>\n${content}\n    </content>\n  </context_file>`,
  );
  return [
    "<project_context>",
    "  <description>Project-specific instructions and guidelines:</description>",
    ...contextFileSections,
    "</project_context>",
  ].join("\n");
}

export function buildMixCodeSystemPromptOptionsFromSession(
  session: {
    getActiveToolNames(): string[];
    getToolDefinition(
      name: string,
    ): { promptSnippet?: string; promptGuidelines?: string[] } | undefined;
  },
  base: Omit<BuildSystemPromptOptions, "selectedTools" | "toolSnippets" | "promptGuidelines">,
): BuildSystemPromptOptions {
  const selectedTools = session.getActiveToolNames();
  const toolSnippets: Record<string, string> = {};
  for (const name of selectedTools) {
    const definition = session.getToolDefinition(name);
    const snippet = normalizePromptSnippet(definition?.promptSnippet);
    if (snippet) {
      toolSnippets[name] = snippet;
    }
  }
  return {
    ...base,
    selectedTools,
    toolSnippets,
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

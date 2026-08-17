import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import {
  type BuildSystemPromptOptions,
  buildSystemPrompt,
  getDocsPath,
} from "@earendil-works/pi-coding-agent";
import { resolveMixcodeAgentDir } from "./paths.js";

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
  const docsSection = buildDocsSection();

  let append = appendSystemPrompt;
  if (conversationHistoryPrompt) {
    append = append ? `${append}\n\n${conversationHistoryPrompt}` : conversationHistoryPrompt;
  }

  const prompt = buildSystemPrompt({
    customPrompt: identity + toolsSection + docsSection,
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

/**
 * Locate MixCode's own `docs/` tree by walking up from this module.
 *
 * The source tree wins so a checkout always reports its live docs. A fixed
 * relative depth does not work there: this file is `src/core/system-prompt.ts`
 * when bun runs the sources but is emitted into `dist/chunk-*.js` one level
 * higher by tsup. `architecture.md` is the marker so an unrelated parent
 * `docs/` cannot be mistaken for MixCode's.
 *
 * The compiled binary has no source tree (`import.meta.dir` is the virtual
 * `/$bunfs/root`, where the walk finds nothing), so `binary-entry.ts` installs
 * the docs into `<agentDir>/mixcode-docs` at startup and that is the fallback.
 * Resolved per call rather than at module load because that install happens
 * after the binary's own top-level imports have been evaluated.
 */
function findMixcodeDocsPath(startDir = import.meta.dir): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, "docs");
    if (existsSync(path.join(candidate, "architecture.md"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const installed = path.join(resolveMixcodeAgentDir(), "mixcode-docs");
  return existsSync(path.join(installed, "architecture.md")) ? installed : undefined;
}

/**
 * Locate Pi's own package directory containing `docs/index.md`.
 *
 * In source or npm/dist mode, Pi's standard `getDocsPath()` works directly.
 * In the standalone compiled binary, `PI_PACKAGE_DIR` points to a temporary
 * runtimeDir with no docs, so `getDocsPath()` fails. We fall back to locating
 * the actual installed Pi package on disk from:
 * 1. `<agentDir>/node_modules/@earendil-works/pi-coding-agent` (maintained by `ensureAgentExtensionRuntimePackages`)
 * 2. Global `pi` CLI binary on PATH (via `which pi` -> realpath -> package root)
 * 3. `node_modules/@earendil-works/pi-coding-agent` in the current working directory
 */
function findPiPackageDir(): string | undefined {
  const defaultDocs = getDocsPath();
  if (existsSync(path.join(defaultDocs, "index.md"))) {
    return path.dirname(defaultDocs);
  }

  const candidates: string[] = [];

  // 1. Agent dir node_modules
  const agentDir = resolveMixcodeAgentDir();
  candidates.push(path.join(agentDir, "node_modules", "@earendil-works", "pi-coding-agent"));

  // 2. Global `pi` executable on PATH
  const piBin = Bun.which("pi");
  if (piBin) {
    let realBin: string | undefined;
    try {
      realBin = realpathSync(piBin);
    } catch (error) {
      // realpathSync ENOENT/ELOOP/EACCES: `pi` on PATH is a dangling or unreadable symlink.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ELOOP" && code !== "EACCES") throw error;
    }
    if (realBin) {
      let dir = path.dirname(realBin);
      for (let i = 0; i < 5; i++) {
        candidates.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }

  // 3. Current working directory node_modules
  candidates.push(path.join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent"));

  for (const dir of candidates) {
    if (existsSync(path.join(dir, "docs", "index.md")) && existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
  }

  return undefined;
}

/**
 * Documentation pointers for "how does MixCode/pi itself work" questions.
 *
 * Only paths that exist on disk are emitted, and an empty string is returned
 * when none do. Pi's docs are resolved through pi's own package location
 * (via `getDocsPath()` in source/dist mode, or dynamically locating the installed
 * `@earendil-works/pi-coding-agent` package on disk in binary mode). MixCode
 * never vendors Pi docs.
 */
function buildDocsSection(): string {
  const lines: string[] = [];
  const mixcodeDocs = findMixcodeDocsPath();
  if (mixcodeDocs) {
    lines.push(
      `- MixCode docs: ${mixcodeDocs} (architecture, tabs, batch Lua, slash commands, settings, environment)`,
    );
  }

  const piPkg = findPiPackageDir();
  if (piPkg) {
    const piReadme = path.join(piPkg, "README.md");
    const piDocs = path.join(piPkg, "docs");
    const piExamples = path.join(piPkg, "examples");

    if (existsSync(piReadme)) lines.push(`- Pi overview: ${piReadme}`);
    if (existsSync(path.join(piDocs, "index.md"))) {
      lines.push(`- Pi docs: ${piDocs} (extensions, skills, themes, TUI, SDK, keybindings, models)`);
    }
    if (existsSync(piExamples)) {
      lines.push(`- Pi examples: ${piExamples} (extensions, custom tools, SDK)`);
    }
  }

  if (lines.length === 0) return "";
  lines.push(
    "- Resolve any docs/... or examples/... reference under the directories above, not the current working directory; list the directory to pick the right file, read it completely, and follow its cross-references before implementing.",
  );
  return `\n\nDocumentation (read only when the user asks about MixCode or pi itself \u2014 its CLI, SDK, extensions, skills, themes, or TUI):\n${lines.join("\n")}`;
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
    // Same bullets as Pi editToolSystemPromptContribution — MixCode owns this
    // section and must not depend on getToolDefinition forwarding.
    for (const guideline of [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ]) {
      addGuideline(guideline);
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

function currentDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

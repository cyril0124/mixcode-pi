/**
 * Pure helpers for /opt-prompt (no Bun APIs — pure Node / plain TS).
 */

export const OPTIMIZE_PROMPT_INHERIT = "inherit";

// Lite rewrite rules: clearer coding-agent tasks without inventing requirements.
export const DEFAULT_OPTIMIZE_SYSTEM_PROMPT = [
  "You are a prompt rewriter, not a chat assistant.",
  "Your only job: rewrite the user's draft into one clearer prompt for a coding agent",
  "that can read/edit files and run shell commands.",
  "",
  "Always rewrite. Never refuse. Never ask the user for more information.",
  "Never ask clarifying questions. Never say you need more context.",
  "If the draft is vague or incomplete, still rewrite it into the best executable task you can:",
  "- state the goal and intended outcome",
  "- list concrete steps or acceptance criteria implied by the draft",
  "- keep unknowns as explicit constraints (e.g. 'path unknown — search the repo'), not questions",
  "",
  "Goals:",
  "- Make the task clearer, more specific, and executable.",
  "- Prefer concrete acceptance criteria over vague goals.",
  "- Keep paths, error messages, stack traces, versions, and constraints verbatim when present.",
  "- Do not invent files, APIs, or requirements not implied by the draft.",
  "- Match the user's language (Chinese stays Chinese, English stays English, etc.).",
  "",
  "Output rules:",
  "- Output only the rewritten prompt text.",
  "- No preamble, no analysis, no bullet list of questions, no markdown fences around the whole prompt.",
].join("\n");

export interface OptimizePromptConfig {
  /** `provider/modelId`; omit or "inherit" = use active session model. */
  model?: string;
  /** Thinking level; omit or "inherit" = use active session thinking. */
  thinking?: string;
  /** Full system prompt override; omit = built-in default. */
  systemPrompt?: string;
  /** Editor `$schema` reference; ignored by behavior, preserved on write. */
  schemaRef?: string;
}

/** Prefer slash args; otherwise use the live editor draft. */
export function resolveOptimizeSource(args: string, editorText = ""): string {
  const fromArgs = args.trim();
  if (fromArgs) return fromArgs;
  return editorText.trim();
}

/** Frame the draft as rewrite input so the model does not chat or ask questions. */
export function formatOptimizeUserMessage(source: string): string {
  return [
    "Rewrite the following draft into one coding-agent prompt.",
    "Do not ask questions. Do not request more information. Output only the rewritten prompt.",
    "",
    "User's original prompt:",
    source,
  ].join("\n");
}

/** Factory-scoped stash for the pre-optimize draft (Pi has no editor history API). */
export type OptimizeDraftSlot = { previous?: string };

export function stashPreOptimizeDraft(slot: OptimizeDraftSlot, source: string): void {
  slot.previous = source;
}

/** Restore the last stashed draft into the editor. */
export function restorePreOptimizeDraft(
  slot: OptimizeDraftSlot,
  setEditorText: (text: string) => void,
): { ok: true; text: string } | { ok: false } {
  if (slot.previous === undefined) return { ok: false };
  setEditorText(slot.previous);
  return { ok: true, text: slot.previous };
}

/** Parse `provider/modelId`; rejects bare ids and trailing slashes. */
export function parseOptimizeModelRef(
  ref: string,
): { provider: string; modelId: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/**
 * Resolve model + thinking for optimize.
 * Unset / inherit config fields fall back to the active session.
 */
export function resolveOptimizeTarget(
  active: { provider: string; modelId: string; thinkingLevel: string },
  config?: Pick<OptimizePromptConfig, "model" | "thinking">,
): { provider: string; modelId: string; thinkingLevel: string } {
  let provider = active.provider;
  let modelId = active.modelId;
  let thinkingLevel = active.thinkingLevel;
  if (config?.model && config.model !== OPTIMIZE_PROMPT_INHERIT) {
    const parsed = parseOptimizeModelRef(config.model);
    if (parsed) {
      provider = parsed.provider;
      modelId = parsed.modelId;
    }
  }
  if (config?.thinking && config.thinking !== OPTIMIZE_PROMPT_INHERIT) {
    thinkingLevel = config.thinking;
  }
  return { provider, modelId, thinkingLevel };
}

export function resolveOptimizeSystemPrompt(config?: Pick<OptimizePromptConfig, "systemPrompt">): string {
  const custom = config?.systemPrompt?.trim();
  return custom || DEFAULT_OPTIMIZE_SYSTEM_PROMPT;
}

/** Usage / config docs for `/opt-prompt help`. */
export function formatOptimizePromptHelp(configPath: string): string {
  return [
    "# opt-prompt",
    "",
    "Rewrite the input-editor draft (or slash args) for a coding agent.",
    "Default rewrite always produces a prompt (no clarifying questions), even when the draft is vague.",
    "",
    "## Usage",
    "",
    "- `/opt-prompt` — optimize the current editor draft (Ctrl+P works too)",
    "- `/opt-prompt <text>` — optimize the given text and write it into the editor",
    "- `/opt-prompt config` — open config overlay (pick model/thinking, edit system prompt)",
    "- `/opt-prompt help` — show this help",
    "- `/opt-prompt cancel` or `/opt-prompt-cancel` — abort in-flight optimize (draft kept)",
    "- `Ctrl+Shift+C` — same cancel, without waiting on the slash-command queue",
    "- `/opt-prompt undo` — restore the pre-optimize draft (extension stash; not Up-history)",
    "",
    "## Config",
    "",
    `File (global): \`${configPath}\``,
    "",
    "`/opt-prompt config` opens an overlay:",
    "- **Model / Thinking** — choose from a list (`inherit` = active session); applies immediately",
    "- **System prompt** — Enter or `e` opens the editor (external editor supported); saves on close",
    "- **Esc** — close the overlay (no separate Save step)",
    "",
    "You can also hand-edit the JSON file. Optional fields (omit = default):",
    "",
    "```json",
    "{",
    '  "model": "provider/modelId",',
    '  "thinking": "low",',
    '  "systemPrompt": "Your custom rewrite instructions..."',
    "}",
    "```",
    "",
    "| Field | Default | Notes |",
    "| --- | --- | --- |",
    "| `model` | inherit active session model | `provider/modelId` |",
    "| `thinking` | inherit active session thinking | e.g. `off`, `low`, `medium`, `high` |",
    "| `systemPrompt` | built-in rewrite instructions | full override; must ask for rewritten prompt only |",
    "",
    "Missing file = all defaults. Invalid JSON is reported as an error.",
    "Progress shows above the editor; the input editor is not taken over.",
    "While optimizing: `/opt-prompt cancel`, `/opt-prompt-cancel`, or Ctrl+Shift+C aborts (draft kept).",
  ].join("\n");
}

export function extractOptimizedText(response: {
  content: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}): string {
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage?.trim() || `Optimize prompt failed (${response.stopReason})`);
  }
  const text = response.content
    .map((block) => (block.text !== undefined ? block.text : ""))
    .filter((part) => part.trim())
    .join("\n")
    .trim();
  if (!text) throw new Error("Optimize prompt returned empty text");
  return text;
}

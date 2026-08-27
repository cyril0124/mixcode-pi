/**
 * MixCode batch execution API for TypeScript/JavaScript scripts.
 *
 * Usage in a `mpi --batch script.ts` file:
 *
 * ```ts
 * /// <reference path="/path/to/mixcode-batch.d.ts" />
 * const script: MixCodeBatchScript = (mixcode) => {
 *   mixcode.openTab({ name: "review", prompt: "Review the current branch." });
 * };
 * export default script;
 * ```
 *
 * Lua counterpart: `mixcode.lua`. Field names are camelCase here.
 */

type MixCodeBatchThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Behavior when a tab with the same name already exists. */
type MixCodeBatchReuseMode = "append" | "clear" | "delete";

interface MixCodeBatchOpenTabOptions {
  /** Tab title; exact match when reusing an existing tab. */
  name: string;
  /** Prompt to submit; omit to create/reuse/clear/delete without submitting. */
  prompt?: string;
  /** Working directory for this tab (defaults to the current workdir). */
  workdir?: string;
  /** Model identifier, e.g. "anthropic/claude-sonnet-4-20250514". */
  model?: string;
  /** Thinking level supported by the selected model. */
  thinking?: MixCodeBatchThinkingLevel;
  /**
   * Base/identity system prompt only (same slot as SYSTEM.md). Tools, AGENTS.md,
   * and skills stay assembled by MixCode. Requires a new session: a new tab, or
   * mode "clear" / "delete".
   */
  systemPrompt?: string;
  /** Reuse behavior when the tab exists (default: "append"). */
  mode?: MixCodeBatchReuseMode;
}

/** Tab snapshot taken at batch startup. */
interface MixCodeBatchTabInfo {
  name: string;
  sessionId: string;
  workdir: string;
  model: string;
  thinking: MixCodeBatchThinkingLevel;
  status: string;
}

/** Model snapshot taken at batch startup. */
interface MixCodeBatchModelInfo {
  /** Canonical id (`provider/modelId`). */
  id: string;
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  reasoning: boolean;
}

interface MixCodeBatchApi {
  /**
   * Open a new agent tab, or reuse an existing one by exact title match.
   *
   * When a tab with the same `name` already exists:
   * - `mode: "append"` (default): the prompt is appended to the existing session
   * - `mode: "clear"`: the session is cleared first, then the prompt is sent
   * - `mode: "delete"`: the tab and its session file are deleted, then a
   *   brand-new tab is created
   *
   * With no matching tab, a new one is created. With `prompt` omitted, the tab
   * is created/reused/cleared/deleted without submitting input.
   *
   * `systemPrompt` replaces only the base identity line; tools/guidelines,
   * APPEND_SYSTEM, project context (AGENTS.md), and skills remain. It is
   * rejected when reusing an existing session with `mode: "append"`.
   *
   * Throws on a missing/empty `name`, a non-string option field, an unknown
   * field name, an unknown model, an invalid thinking level, or
   * `append` + `systemPrompt`.
   */
  openTab(options: MixCodeBatchOpenTabOptions): void;
  /**
   * CLI arguments after `--`.
   * Example: `mpi --batch s.ts -- foo bar` yields `["foo", "bar"]`.
   */
  args(): string[];
  /** The current MixCode workdir. */
  currentWorkdir(): string;
  /** Whether a tab with this exact title exists at batch startup. */
  tabExists(name: string): boolean;
  /** Tabs visible at batch startup (snapshot; not live). */
  listTabs(): MixCodeBatchTabInfo[];
  /** Models available at batch startup (snapshot; not live). */
  listModels(): MixCodeBatchModelInfo[];
  /**
   * Render a string template using `{name}` placeholders. Use `{{` and `}}` to
   * output literal braces. Missing variables (including `null`/`undefined`) and
   * invalid placeholder names raise an error.
   */
  render(template: string, vars: Record<string, unknown>): string;
}

/**
 * Default export shape of a batch script. It may be async; the execution plan
 * is collected after the returned promise resolves.
 */
type MixCodeBatchScript = (mixcode: MixCodeBatchApi) => void | Promise<void>;

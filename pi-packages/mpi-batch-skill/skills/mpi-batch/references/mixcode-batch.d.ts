/**
 * MixCode batch execution API for TypeScript/JavaScript scripts.
 *
 * Write a script file and run it with `mpi --batch script.ts` or `/batch script.ts`:
 *
 * ```ts
 * /// <reference path="/path/to/mixcode-batch.d.ts" />
 * const script: MixCodeBatchScript = (mixcode) => {
 *   mixcode.openTab({ name: "review", prompt: "Review the current branch." });
 * };
 * export default script;
 * ```
 *
 * Lua counterpart: `mixcode-batch.d.lua`. Field names are camelCase here.
 */

type MixCodeBatchThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Behavior when a tab with the same name already exists. */
type MixCodeBatchReuseMode = "append" | "clear" | "delete";

interface MixCodeBatchOpenTabOptions {
  /** Tab title; exact match when reusing an existing tab. */
  name: string;
  /**
   * One input to submit; mutually exclusive with prompts when defined.
   * Runtime null/undefined mean omitted; omit both fields to operate without input.
   * Supports skills, templates, extension commands, and !shell / !!shell.
   * Registered MixCode local commands, including /batch, fail at dispatch.
   * Other slash input and paths pass unchanged to Pi; unmatched input becomes message text.
   */
  prompt?: string;
  /**
   * Dense array of prompts or local commands; mutually exclusive with prompt.
   * Empty and whitespace-only strings are skipped; at least one nonblank entry
   * is required. Runtime null/undefined mean omitted. Dry-run lists retained
   * entries with their original text; execution trims leading and trailing whitespace. Shell input (! / !!)
   * fails preflight before tab mutations. MixCode local commands run as separate
   * steps on the owning tab, with their normal confirmations and completion rules.
   * If a confirmation is cancelled or a command throws, the remaining queue pauses.
   * Skills, named templates, extension commands, unknown slash input, and paths work.
   * Apply appends the whole array synchronously as exclusive follow-up rounds
   * behind existing entries and returns after enqueueing, not model completion.
   * Does not resume a paused queue. See ../SKILL.md#prompt-sequences for lifecycle,
   * shared configuration, and asynchronous failure behavior.
   */
  prompts?: string[];
  /** New-tab directory; defaults and relative paths use currentWorkdir(). Reuse/clear keeps the existing directory. */
  workdir?: string;
  /** Model identifier from listModels().id; omitted means keep existing or use the instance default for a new tab. */
  model?: string;
  /** Supported thinking level; omitted means keep existing or use the instance default for a new tab. */
  thinking?: MixCodeBatchThinkingLevel;
  /**
   * Session context budget: a positive safe integer token count, or a /context-limit
   * string such as "32000", "32k", "32.5k", or "reset". Strings trim whitespace,
   * ignore case, and use /context-limit numeric rounding; resulting tokens must
   * be positive safe integers. Runtime null/undefined mean omitted.
   * Applied after each request's model/thinking and before its optional prompt,
   * including later same-name requests and all modes. "reset" restores the
   * selected model's canonical window. Omission uses the model default for a new
   * tab and retains a reused tab's limit unless explicit model selection resets it.
   * Synchronizes session contextWindow, UI, and compaction budgets for this session
   * only; no global config change. Above-capacity values warn without expanding
   * provider capacity. Invalid values fail before any tab changes with Error: and
   * the tab name; the script loader adds the script path.
   */
  contextLimit?: number | string;
  /**
   * Base/identity system prompt only (same slot as SYSTEM.md). Tools, AGENTS.md,
   * and skills stay assembled by MixCode. Requires a new tab or mode "delete";
   * rejected with mode "clear" even without a matching tab.
   */
  systemPrompt?: string;
  /** Reuse behavior when the tab exists (default: "append"). */
  mode?: MixCodeBatchReuseMode;
}

/** Tab snapshot captured before each script invocation; not live. */
interface MixCodeBatchTabInfo {
  name: string;
  sessionId: string;
  workdir: string;
  /** Model display name, not necessarily a canonical provider/modelId. */
  model: string;
  thinking: MixCodeBatchThinkingLevel;
  status: string;
}

/** Model catalog captured before each invocation; includes disabled entries without a disabled field. */
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
   * Collect a tab request. MixCode applies it after the script finishes.
   *
   * When a tab with the same `name` already exists:
   * - `mode: "append"` (default): continue the session; a streaming `prompt` uses steering
   * - `mode: "clear"`: reset the branch to session root, then send the prompt.
   *   Keeps title, session ID/file, workdir, system prompt, and focus. History stays in
   *   /tree, outside the new context. No extension reload or service rebuild;
   *   rejected while streaming or bash is running.
   * - `mode: "delete"`: the tab and its session file are deleted, then a
   *   brand-new tab is created
   *
   * With no matching tab, a new one is created. With both `prompt` and `prompts` omitted, the tab
   * is created/reused/cleared/deleted without submitting input. New tabs and
   * delete replacements take focus. Setup failures stop before prompt dispatch;
   * during parallel dispatch, other groups continue after one fails. Applied
   * changes remain in both cases. See ../SKILL.md#execution-and-errors for
   * command errors and persistence.
   *
   * `systemPrompt` replaces only the base identity line; tools/guidelines,
   * APPEND_SYSTEM, project context (AGENTS.md), and skills remain. It is
   * rejected when reusing an existing session with `mode: "append"`, or with
   * `mode: "clear"` even without a matching tab. Clear + systemPrompt (including
   * an empty string) fails validation before any tab changes.
   * For repeated names, only the first request controls creation/reset/deletion.
   * Interactive /clear still replaces the session and resets its title.
   *
   * Throws on a missing/empty name, invalid option types or contextLimit,
   * conflicting prompt/prompts, an invalid prompts array, or an unknown field name.
   * Prompt-sequence validation runs during collection and again before tab changes.
   * Model, thinking, mode, and systemPrompt validation happens after collection,
   * before tab changes.
   */
  openTab(options: MixCodeBatchOpenTabOptions): void;
  /**
   * Arguments after `--` in startup CLI or /batch.
   * Example: `/batch s.ts -- foo ""` yields ["foo", ""].
   * /batch supports quotes and backslash escaping except inside single quotes;
   * no shell variable, command, or glob expansion occurs.
   */
  args(): string[];
  /**
   * Invocation directory: calling Agent tab workdir for /batch, instance workdir
   * on Home, launch workdir for CLI. Also resolves the script path and new-tab
   * workdirs. Does not change process.cwd(); script-owned relative I/O uses host cwd.
   */
  currentWorkdir(): string;
  /**
   * Absolute directory containing the entry script file. Symlinks are not resolved.
   * Differs from currentWorkdir() when the script is kept outside the invocation
   * directory. Always the entry script. Lua's `script_dir()` reports the file that
   * calls it, so a required module sees its own directory.
   */
  scriptDir(): string;
  /** Whether a tab with this exact title exists in this invocation's snapshot. */
  tabExists(name: string): boolean;
  /** Tabs captured before this invocation (snapshot; not live). */
  listTabs(): MixCodeBatchTabInfo[];
  /**
   * Resolve an exact model id or provider/modelId to an enabled canonical id.
   * Uses a fresh invocation snapshot of models, disabled IDs, and the instance default provider.
   * Prefer the captured instance default provider, then the smallest provider name
   * in case-sensitive JS string order. Canonical references never change routes;
   * disabled candidates are excluded from automatic selection.
   * Trims surrounding whitespace; throws for invalid/unknown queries or disabled
   * explicit references. No I/O, fuzzy matching, or model-version substitution.
   */
  resolveModel(query: string): string;
  /** Invocation model catalog (not live); includes disabled entries without a disabled field. */
  listModels(): MixCodeBatchModelInfo[];
  /**
   * Render a string template using `{name}` placeholders. Use `{{` and `}}` to
   * output literal braces. Missing variables (including `null`/`undefined`) and
   * invalid placeholder names raise an error. Names must match
   * [A-Za-z_][A-Za-z0-9_]*; unmatched braces also raise an error.
   */
  render(template: string, vars: Record<string, unknown>): string;
}

/**
 * Default export shape of a batch script. It may be async; the execution plan
 * is collected after the returned promise resolves. Each invocation calls this
 * function with fresh context. ES module caching preserves module-level state;
 * file edits require restarting MixCode.
 */
type MixCodeBatchScript = (mixcode: MixCodeBatchApi) => void | Promise<void>;

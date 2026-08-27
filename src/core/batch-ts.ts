import { pathToFileURL } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  BatchLuaContext,
  BatchLuaModelInfo,
  BatchLuaTabInfo,
  BatchPlan,
  BatchReuseMode,
  BatchTabRequest,
} from "./batch-lua.js";
import { renderTemplate } from "./batch-lua.js";

/**
 * TypeScript mirror of the Lua `mixcode` global table. Fields are camelCase
 * (`systemPrompt`) where Lua uses snake_case (`system_prompt`); semantics,
 * validation, and the resulting BatchPlan are identical.
 *
 * The public stub users reference from their own scripts is `mixcode-batch.d.ts`
 * at the repository root; `test/batch-ts.test.ts` asserts both stay structurally
 * identical.
 */
export interface MixCodeBatchOpenTabOptions {
  name: string;
  prompt?: string;
  workdir?: string;
  model?: string;
  thinking?: ThinkingLevel;
  systemPrompt?: string;
  mode?: BatchReuseMode;
}

export interface MixCodeBatchApi {
  openTab(options: MixCodeBatchOpenTabOptions): void;
  args(): string[];
  currentWorkdir(): string;
  tabExists(name: string): boolean;
  listTabs(): BatchLuaTabInfo[];
  listModels(): BatchLuaModelInfo[];
  render(template: string, vars: Record<string, unknown>): string;
}

export type MixCodeBatchScript = (mixcode: MixCodeBatchApi) => void | Promise<void>;

/**
 * Load and run a TypeScript/JavaScript batch script.
 *
 * The module must default-export a function; it is called with the `mixcode`
 * API and awaited, so scripts may be async (read files, shell out, fetch).
 * Scripts run in-process with full host privileges — same trust level as Lua
 * batch scripts, but without fengari's sandbox.
 *
 * Throws when the module has no callable default export or when an `openTab`
 * call passes malformed options. Load and run failures are rewrapped as
 * `Batch script error in <path>` so the failing script is named, matching the
 * Lua executor.
 */
export async function runTsScript(
  scriptPath: string,
  context: BatchLuaContext = { workdir: "", tabs: [] },
): Promise<BatchPlan> {
  const module: unknown = await withScriptPath(
    scriptPath,
    () => import(pathToFileURL(scriptPath).href),
  );
  const script = (module as { default?: unknown }).default;
  if (typeof script !== "function") {
    throw new Error(`Batch script must default-export a function: ${scriptPath}`);
  }

  const requests: BatchTabRequest[] = [];
  const api: MixCodeBatchApi = {
    openTab(options) {
      requests.push(toTabRequest(options, scriptPath));
    },
    args: () => [...(context.args ?? [])],
    currentWorkdir: () => context.workdir,
    tabExists: (name) => context.tabs.some((tab) => tab.name === name),
    // Copies: a script mutating the returned rows must not corrupt host state.
    listTabs: () => context.tabs.map((tab) => ({ ...tab })),
    listModels: () => (context.models ?? []).map((model) => ({ ...model })),
    render: (template, vars) =>
      renderTemplate(template, (name) => {
        const value = vars[name];
        // null behaves like Lua's nil: a missing variable, not the text "null".
        return value === undefined || value === null ? undefined : String(value);
      }),
  };

  await withScriptPath(scriptPath, () => (script as MixCodeBatchScript)(api));
  return { requests };
}

/**
 * Run `action`, rewrapping any thrown error with the script path. Errors this
 * module raises itself already name the path and are passed through unchanged.
 */
async function withScriptPath<T>(scriptPath: string, action: () => Promise<T> | T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(scriptPath)) throw error;
    throw new Error(`Batch script error in ${scriptPath}: ${message}`, { cause: error });
  }
}

const OPEN_TAB_FIELDS = [
  "name",
  "prompt",
  "workdir",
  "model",
  "thinking",
  "systemPrompt",
  "mode",
] as const satisfies ReadonlyArray<keyof MixCodeBatchOpenTabOptions>;

/**
 * Validate one `openTab` argument. The script is an external boundary (plain
 * JS is allowed, and TS types are erased at runtime), so every field is checked
 * instead of trusted. Unknown keys are rejected rather than dropped: the Lua
 * field names are snake_case, so `system_prompt` here is a likely migration
 * typo that would otherwise silently change the resulting session.
 */
function toTabRequest(options: MixCodeBatchOpenTabOptions, scriptPath: string): BatchTabRequest {
  if (typeof options !== "object" || options === null) {
    throw new Error(`mixcode.openTab expects an options object (${scriptPath})`);
  }
  const unknownKeys = Object.keys(options).filter(
    (key) => !(OPEN_TAB_FIELDS as ReadonlyArray<string>).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `mixcode.openTab: unknown field(s) ${unknownKeys.join(", ")} (${scriptPath}). ` +
        `Valid fields: ${OPEN_TAB_FIELDS.join(", ")}`,
    );
  }
  const name = options.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`mixcode.openTab: 'name' must be a non-empty string (${scriptPath})`);
  }
  return {
    name,
    prompt: optionalString(options.prompt, "prompt", name, scriptPath),
    workdir: optionalString(options.workdir, "workdir", name, scriptPath),
    model: optionalString(options.model, "model", name, scriptPath),
    thinking: optionalString(options.thinking, "thinking", name, scriptPath),
    systemPrompt: optionalString(options.systemPrompt, "systemPrompt", name, scriptPath),
    // Enum membership is checked downstream by validateBatchRequests, together
    // with the Lua path.
    mode: optionalString(options.mode, "mode", name, scriptPath) as BatchReuseMode | undefined,
  };
}

function optionalString(
  value: unknown,
  field: string,
  tabName: string,
  scriptPath: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `mixcode.openTab: '${field}' must be a string for tab '${tabName}' (${scriptPath})`,
    );
  }
  return value;
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeModelRef, MixCodeState } from "./types.js";

/**
 * Parsed open_tab request from Lua script.
 * Collected during Lua execution, then applied to the TUI state/runtime.
 */
export type BatchReuseMode = "append" | "clear";

export interface BatchTabRequest {
  name: string;
  prompt: string;
  workdir?: string;
  model?: string;
  thinking?: string;
  /** Behavior when reusing an existing tab: "append" (default) or "clear". */
  mode?: BatchReuseMode;
}

/**
 * Host interface that the batch executor uses to interact with the TUI runtime.
 * Decouples Lua execution from concrete runtime/state dependencies.
 */
export interface BatchExecutorHost {
  state: MixCodeState;
  findTabByTitle(title: string): { sessionId: string } | undefined;
  createNewTab(request: BatchTabRequest): Promise<string>;
  /** Apply model/thinking overrides before submitting input. */
  configureTab(
    sessionId: string,
    options: { model?: MixCodeModelRef; thinking?: ThinkingLevel },
  ): Promise<void>;
  /** Clear an existing tab's session (reset conversation) and return the new session id. */
  clearTab(sessionId: string): Promise<string>;
  /**
   * Submit input to a tab, going through the full TUI input pipeline:
   * parseInput → buildModelPrompt ($ skill, /template expansion) → runtime.prompt
   * Also supports /commands and !shell.
   */
  submitInput(sessionId: string, input: string): Promise<void>;
  resolveModel(query: string): MixCodeModelRef;
}

/**
 * Execute a Lua batch script file.
 * Collects all open_tab calls, validates them, then applies them to the host.
 *
 * Throws on any failure (file not found, Lua syntax error, runtime error,
 * tab not found for reuse, unknown model, etc.).
 */
export async function loadBatchRequests(scriptPath: string): Promise<BatchTabRequest[]> {
  const absPath = resolve(scriptPath);
  const source = await readFile(absPath, "utf-8");
  return runLuaScript(source, absPath);
}

export async function executeBatchScript(
  scriptPath: string,
  host: BatchExecutorHost,
): Promise<void> {
  const requests = await loadBatchRequests(scriptPath);
  await applyBatchRequests(requests, host);
}

/**
 * Run the Lua source and collect all mixcode.open_tab() calls.
 * Pure Lua execution — no side effects on the TUI.
 */
export async function runLuaScript(
  source: string,
  scriptPath: string,
): Promise<BatchTabRequest[]> {
  // Dynamic import because fengari is CJS-only
  const fengari = await import("fengari");
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari.default ?? fengari;

  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  const requests: BatchTabRequest[] = [];

  // Register mixcode.open_tab(opts)
  lua.lua_newtable(L);
  lua.lua_pushcfunction(L, (L: any) => {
    if (!lua.lua_istable(L, 1)) {
      return lauxlib.luaL_error(L, to_luastring("mixcode.open_tab expects a table argument"));
    }

    const name = getStringField(L, 1, "name", lua, lauxlib, to_luastring, to_jsstring);
    if (!name) {
      return lauxlib.luaL_error(L, to_luastring("mixcode.open_tab: 'name' field is required"));
    }

    const prompt = getStringField(L, 1, "prompt", lua, lauxlib, to_luastring, to_jsstring);
    if (!prompt) {
      return lauxlib.luaL_error(L, to_luastring("mixcode.open_tab: 'prompt' field is required"));
    }

    const workdir =
      getStringField(L, 1, "workdir", lua, lauxlib, to_luastring, to_jsstring) ?? undefined;
    const model =
      getStringField(L, 1, "model", lua, lauxlib, to_luastring, to_jsstring) ?? undefined;
    const thinking =
      getStringField(L, 1, "thinking", lua, lauxlib, to_luastring, to_jsstring) ?? undefined;
    const mode =
      (getStringField(L, 1, "mode", lua, lauxlib, to_luastring, to_jsstring) as BatchReuseMode | null) ?? undefined;

    requests.push({ name, prompt, workdir, model, thinking, mode });
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("open_tab"));
  lua.lua_setglobal(L, to_luastring("mixcode"));

  // Execute the script
  const status = lauxlib.luaL_dostring(L, to_luastring(source));
  if (status !== 0) {
    const errMsg = to_jsstring(lua.lua_tostring(L, -1));
    throw new Error(`Lua error in ${scriptPath}: ${errMsg}`);
  }

  return requests;
}

/**
 * Apply collected batch requests to the host.
 * For each request: reuse existing tab (by exact title match) or create new.
 * All tabs are started in parallel (fire-and-forget prompts).
 * Throws on first failure (tab not found, model unknown, etc.).
 */
export function validateBatchRequests(
  requests: BatchTabRequest[],
  resolveModel: (query: string) => MixCodeModelRef,
): void {
  for (const request of requests) {
    if (request.model) resolveModel(request.model);
    if (request.thinking) {
      const valid: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
      if (!valid.includes(request.thinking as ThinkingLevel)) {
        throw new Error(
          `Invalid thinking level '${request.thinking}' for tab '${request.name}'. ` +
            `Valid values: ${valid.join(", ")}`,
        );
      }
    }
    if (request.mode && request.mode !== "append" && request.mode !== "clear") {
      throw new Error(
        `Invalid mode '${request.mode}' for tab '${request.name}'. Valid values: append, clear`,
      );
    }
  }
}

export async function applyBatchRequests(
  requests: BatchTabRequest[],
  host: BatchExecutorHost,
): Promise<void> {
  if (requests.length === 0) return;

  validateBatchRequests(requests, (query) => host.resolveModel(query));

  // Validate all requests before applying any (fail-fast)
  const resolved: Array<{
    request: BatchTabRequest;
    existingSessionId: string | undefined;
    model: MixCodeModelRef | undefined;
    thinking: ThinkingLevel | undefined;
  }> = [];

  for (const request of requests) {
    const existing = host.findTabByTitle(request.name);
    let model: MixCodeModelRef | undefined;
    if (request.model) {
      model = host.resolveModel(request.model);
    }
    const thinking = request.thinking as ThinkingLevel | undefined;
    resolved.push({ request, existingSessionId: existing?.sessionId, model, thinking });
  }

  // Group by tab name: same-name requests execute sequentially (order matters).
  const groups = new Map<string, typeof resolved>();
  for (const entry of resolved) {
    const group = groups.get(entry.request.name);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.request.name, [entry]);
    }
  }

  // Phase 1: Create/clear tabs sequentially (runtime.createTab doesn't support concurrency)
  const groupSessions = new Map<string, string>();
  for (const [name, group] of groups) {
    let sessionId: string | undefined = group[0]!.existingSessionId;
    if (!sessionId) {
      sessionId = await host.createNewTab(group[0]!.request);
    } else if (group[0]!.request.mode === "clear") {
      sessionId = await host.clearTab(sessionId);
    }
    groupSessions.set(name, sessionId);
  }

  // Phase 2: Configure tabs and send prompts in parallel (fire-and-forget per group)
  const operations = [...groups.entries()].map(async ([name, group]) => {
    const sessionId = groupSessions.get(name)!;
    for (const { request, model, thinking } of group) {
      if (model || thinking) await host.configureTab(sessionId, { model, thinking });
      await host.submitInput(sessionId, request.prompt);
    }
  });

  await Promise.all(operations);
}

// Helper to read a string field from a Lua table at the given stack index
function getStringField(
  L: any,
  tableIndex: number,
  field: string,
  lua: any,
  _lauxlib: any,
  to_luastring: (s: string) => Uint8Array,
  to_jsstring: (s: Uint8Array) => string,
): string | null {
  lua.lua_getfield(L, tableIndex, to_luastring(field));
  if (lua.lua_isnil(L, -1) || lua.lua_isnoneornil(L, -1)) {
    lua.lua_pop(L, 1);
    return null;
  }
  const value = to_jsstring(lua.lua_tostring(L, -1));
  lua.lua_pop(L, 1);
  return value;
}

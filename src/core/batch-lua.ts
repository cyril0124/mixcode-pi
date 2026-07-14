import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { modelRefId } from "./models.js";
import { isThinkingLevelAvailable, validThinkingLevelsMessage } from "./thinking-levels.js";
import type { MixCodeModelRef, MixCodeState } from "./types.js";

/**
 * Parsed open_tab request from Lua script.
 * Collected during Lua execution, then applied to the TUI state/runtime.
 */
export type BatchReuseMode = "append" | "clear" | "delete";

export interface BatchLuaTabInfo {
  name: string;
  sessionId: string;
  workdir: string;
  model: string;
  thinking: ThinkingLevel;
  status: string;
}

export interface BatchLuaModelInfo {
  id: string;
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  reasoning: boolean;
}

export interface BatchLuaContext {
  workdir: string;
  tabs: BatchLuaTabInfo[];
  /** Available models snapshot at batch startup. */
  models?: BatchLuaModelInfo[];
  /** CLI args after `--` (e.g. mixcode-pi --batch s.lua -- foo bar). */
  args?: string[];
}

export interface BatchTabRequest {
  name: string;
  /** Optional: omit to create/reuse a tab without submitting a prompt. */
  prompt?: string;
  workdir?: string;
  model?: string;
  thinking?: string;
  /**
   * Base/identity system prompt only (same slot as SYSTEM.md / MIXCODE_SYSTEM_PROMPT).
   * Tools, append, project context, and skills remain assembled by MixCode.
   * Requires a new session: create, mode="clear", or mode="delete".
   */
  systemPrompt?: string;
  /** Behavior when reusing an existing tab: "append" (default), "clear", or "delete". */
  mode?: BatchReuseMode;
}

/** Collected plan from a batch Lua script. */
export interface BatchPlan {
  requests: BatchTabRequest[];
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
  clearTab(sessionId: string, options?: { systemPrompt?: string }): Promise<string>;
  /** Delete an existing tab and its session file from disk. */
  deleteTab(sessionId: string): Promise<void>;
  /**
   * Submit agent-directed input through the shared prompt pipeline: normal
   * prompts, skills, prompt templates, extension commands, and !shell. MixCode
   * local commands are rejected because batch mode has no interactive UI to own
   * pickers, confirmations, or overlays.
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
export async function loadBatchRequests(
  scriptPath: string,
  context?: BatchLuaContext,
): Promise<BatchPlan> {
  const absPath = resolve(scriptPath);
  const source = await readFile(absPath, "utf-8");
  return runLuaScript(source, absPath, context);
}

export async function executeBatchScript(
  scriptPath: string,
  host: BatchExecutorHost,
): Promise<void> {
  const plan = await loadBatchRequests(scriptPath, contextFromState(host.state));
  await applyBatchRequests(plan.requests, host);
}

/**
 * Run the Lua source and collect all mixcode.open_tab() calls.
 * Pure Lua execution — no side effects on the TUI.
 */
export async function runLuaScript(
  source: string,
  scriptPath: string,
  context: BatchLuaContext = { workdir: "", tabs: [] },
): Promise<BatchPlan> {
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

    // prompt is optional: omit to create/reuse a tab without submitting input.
    const prompt =
      getStringField(L, 1, "prompt", lua, lauxlib, to_luastring, to_jsstring) ?? undefined;

    const workdir =
      getStringField(L, 1, "workdir", lua, lauxlib, to_luastring, to_jsstring) ?? undefined;
    const model =
      getStringField(L, 1, "model", lua, lauxlib, to_luastring, to_jsstring) ?? undefined;
    const thinking =
      getStringField(L, 1, "thinking", lua, lauxlib, to_luastring, to_jsstring) ?? undefined;
    const systemPrompt =
      getStringField(L, 1, "system_prompt", lua, lauxlib, to_luastring, to_jsstring) ?? undefined;
    const mode =
      (getStringField(L, 1, "mode", lua, lauxlib, to_luastring, to_jsstring) as BatchReuseMode | null) ?? undefined;

    requests.push({ name, prompt, workdir, model, thinking, systemPrompt, mode });
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("open_tab"));

  lua.lua_pushcfunction(L, () => {
    lua.lua_pushstring(L, to_luastring(context.workdir));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("current_workdir"));

  // CLI args after `--`; 1-indexed Lua array.
  lua.lua_pushcfunction(L, (L: any) => {
    const args = context.args ?? [];
    lua.lua_createtable(L, args.length, 0);
    args.forEach((arg, index) => {
      lua.lua_pushstring(L, to_luastring(arg));
      lua.lua_rawseti(L, -2, index + 1);
    });
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("args"));

  lua.lua_pushcfunction(L, (L: any) => {
    const name = lua.lua_isnoneornil(L, 1) ? "" : to_jsstring(lua.lua_tostring(L, 1));
    lua.lua_pushboolean(L, context.tabs.some((tab) => tab.name === name));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("tab_exists"));

  lua.lua_pushcfunction(L, (L: any) => {
    lua.lua_createtable(L, context.tabs.length, 0);
    context.tabs.forEach((tab, index) => {
      lua.lua_createtable(L, 0, 6);
      setStringField(L, "name", tab.name, lua, to_luastring);
      setStringField(L, "session_id", tab.sessionId, lua, to_luastring);
      setStringField(L, "workdir", tab.workdir, lua, to_luastring);
      setStringField(L, "model", tab.model, lua, to_luastring);
      setStringField(L, "thinking", tab.thinking, lua, to_luastring);
      setStringField(L, "status", tab.status, lua, to_luastring);
      lua.lua_rawseti(L, -2, index + 1);
    });
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("list_tabs"));

  // Startup snapshot of available models (same lifetime as list_tabs).
  lua.lua_pushcfunction(L, (L: any) => {
    const models = context.models ?? [];
    lua.lua_createtable(L, models.length, 0);
    models.forEach((model, index) => {
      lua.lua_createtable(L, 0, 6);
      setStringField(L, "id", model.id, lua, to_luastring);
      setStringField(L, "provider", model.provider, lua, to_luastring);
      setStringField(L, "model_id", model.modelId, lua, to_luastring);
      setStringField(L, "display_name", model.displayName, lua, to_luastring);
      lua.lua_pushnumber(L, model.contextWindow);
      lua.lua_setfield(L, -2, to_luastring("context_window"));
      lua.lua_pushboolean(L, model.reasoning);
      lua.lua_setfield(L, -2, to_luastring("reasoning"));
      lua.lua_rawseti(L, -2, index + 1);
    });
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("list_models"));

  const renderFn = (L: any) => luaRender(L, lua, lauxlib, to_luastring, to_jsstring);
  lua.lua_pushcfunction(L, renderFn);
  lua.lua_setfield(L, -2, to_luastring("render"));

  lua.lua_setglobal(L, to_luastring("mixcode"));
  lua.lua_pushcfunction(L, renderFn);
  lua.lua_setglobal(L, to_luastring("render"));

  // Execute the script
  const status = lauxlib.luaL_dostring(L, to_luastring(source));
  if (status !== 0) {
    const errMsg = to_jsstring(lua.lua_tostring(L, -1));
    throw new Error(`Lua error in ${scriptPath}: ${errMsg}`);
  }

  return { requests };
}

/**
 * Apply collected batch requests to the host.
 * For each request: reuse existing tab (by exact title match) or create new.
 * Different tabs run in parallel; requests for the same tab run sequentially.
 * Throws on first failure (tab not found, model unknown, etc.).
 */
export function validateBatchRequests(
  requests: BatchTabRequest[],
  resolveModel: (query: string) => MixCodeModelRef,
  resolveImplicitModel: (request: BatchTabRequest) => MixCodeModelRef | undefined = () => undefined,
): void {
  const effectiveModels = new Map<string, MixCodeModelRef>();
  for (const request of requests) {
    const model = request.model
      ? resolveModel(request.model)
      : (effectiveModels.get(request.name) ?? resolveImplicitModel(request));
    if (model) effectiveModels.set(request.name, model);
    if (request.thinking && !isThinkingLevelAvailable(request.thinking, model)) {
      throw new Error(
        `Invalid thinking level '${request.thinking}' for tab '${request.name}'. ` +
          `Valid values: ${validThinkingLevelsMessage(model)}`,
      );
    }
    if (request.mode && !["append", "clear", "delete"].includes(request.mode)) {
      throw new Error(
        `Invalid mode '${request.mode}' for tab '${request.name}'. Valid values: append, clear, delete`,
      );
    }
  }
}

/**
 * system_prompt only applies when a new session is created (new tab, clear, or
 * delete). Append reuse keeps the existing session base prompt.
 */
export function validateSystemPromptRequests(
  requests: BatchTabRequest[],
  findExisting: (name: string) => boolean,
): void {
  const seenNames = new Set<string>();
  for (const request of requests) {
    if (!request.systemPrompt) {
      seenNames.add(request.name);
      continue;
    }
    if (seenNames.has(request.name)) {
      throw new Error(
        `system_prompt for tab '${request.name}' only applies when creating a new session; ` +
          `later requests for the same tab reuse the session`,
      );
    }
    seenNames.add(request.name);
    const mode = request.mode ?? "append";
    if (findExisting(request.name) && mode === "append") {
      throw new Error(
        `system_prompt for tab '${request.name}' requires a new session; ` +
          `use mode="clear" or mode="delete", or a new tab name`,
      );
    }
  }
}

export async function applyBatchRequests(
  requests: BatchTabRequest[],
  host: BatchExecutorHost,
): Promise<void> {
  if (requests.length === 0) return;

  validateBatchRequests(
    requests,
    (query) => host.resolveModel(query),
    (request) =>
      request.mode === "delete"
        ? host.state.model
        : (host.state.tabs.find((tab) => tab.title === request.name)?.model ?? host.state.model),
  );
  validateSystemPromptRequests(requests, (name) => Boolean(host.findTabByTitle(name)));

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

  // Phase 1: Create/clear/delete tabs sequentially (runtime.createTab doesn't support concurrency)
  const groupSessions = new Map<string, string>();
  for (const [name, group] of groups) {
    let sessionId: string | undefined = group[0]!.existingSessionId;
    if (sessionId && group[0]!.request.mode === "delete") {
      // Delete = destroy the old tab (session file included), then start from scratch.
      await host.deleteTab(sessionId);
      sessionId = undefined;
    }
    if (!sessionId) {
      sessionId = await host.createNewTab(group[0]!.request);
    } else if (group[0]!.request.mode === "clear") {
      sessionId = await host.clearTab(sessionId, {
        systemPrompt: group[0]!.request.systemPrompt,
      });
    }
    groupSessions.set(name, sessionId);
  }

  // Phase 2: Run tab groups in parallel while preserving request order within each tab.
  await Promise.all(
    [...groups.entries()].map(async ([name, group]) => {
      const sessionId = groupSessions.get(name)!;
      for (const { request, model, thinking } of group) {
        if (model || thinking) await host.configureTab(sessionId, { model, thinking });
        if (request.prompt !== undefined) await host.submitInput(sessionId, request.prompt);
      }
    }),
  );
}

/** Human-readable plan for --batch-dry-run. */
export function formatBatchPlan(plan: BatchPlan): string {
  const lines = [`Batch dry-run: ${plan.requests.length} request(s)`];
  plan.requests.forEach((req, index) => {
    const parts = [`${index + 1}. name=${req.name}`];
    if (req.mode) parts.push(`mode=${req.mode}`);
    if (req.model) parts.push(`model=${req.model}`);
    if (req.thinking) parts.push(`thinking=${req.thinking}`);
    if (req.workdir) parts.push(`workdir=${req.workdir}`);
    if (req.systemPrompt) parts.push("system_prompt=yes");
    lines.push(parts.join(" "));
    lines.push(req.prompt === undefined ? "   prompt: (none)" : `   prompt: ${req.prompt}`);
  });
  return lines.join("\n");
}

export function renderTemplate(
  template: string,
  resolveVar: (name: string) => string | undefined,
): string {
  let output = "";
  for (let index = 0; index < template.length; index++) {
    const char = template[index];
    const next = template[index + 1];
    if (char === "{" && next === "{") {
      output += "{";
      index++;
      continue;
    }
    if (char === "}" && next === "}") {
      output += "}";
      index++;
      continue;
    }
    if (char === "}") throw new Error("Unexpected '}' in template");
    if (char !== "{") {
      output += char;
      continue;
    }
    const end = template.indexOf("}", index + 1);
    if (end < 0) throw new Error("Unclosed '{' in template");
    const name = template.slice(index + 1, end);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid template variable: ${name || "<empty>"}`);
    }
    const value = resolveVar(name);
    if (value === undefined) throw new Error(`Missing template variable: ${name}`);
    output += value;
    index = end;
  }
  return output;
}

export function contextFromState(state: MixCodeState): BatchLuaContext {
  return {
    workdir: state.workdir,
    tabs: state.tabs.map((tab) => ({
      name: tab.title,
      sessionId: tab.sessionId,
      workdir: tab.workdir,
      model: tab.model.displayName,
      thinking: tab.thinkingLevel,
      status: tab.status,
    })),
    models: state.availableModels.map((model) => ({
      id: modelRefId(model),
      provider: model.provider,
      modelId: model.modelId,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      reasoning: Boolean(model.reasoning),
    })),
  };
}

// Helper to read a string field from a Lua table at the given stack index
function getStringField(
  L: any,
  tableIndex: number,
  field: string,
  lua: any,
  lauxlib: any,
  to_luastring: (s: string) => Uint8Array,
  to_jsstring: (s: Uint8Array) => string,
): string | null {
  lua.lua_getfield(L, tableIndex, to_luastring(field));
  if (lua.lua_isnil(L, -1) || lua.lua_isnoneornil(L, -1)) {
    lua.lua_pop(L, 1);
    return null;
  }
  if (lua.lua_type(L, -1) !== lua.LUA_TSTRING) {
    return lauxlib.luaL_error(L, to_luastring(`mixcode.open_tab: '${field}' field must be a string`));
  }
  const value = to_jsstring(lua.lua_tostring(L, -1));
  lua.lua_pop(L, 1);
  return value;
}

function setStringField(
  L: any,
  field: string,
  value: string,
  lua: any,
  to_luastring: (s: string) => Uint8Array,
): void {
  lua.lua_pushstring(L, to_luastring(value));
  lua.lua_setfield(L, -2, to_luastring(field));
}

function luaRender(
  L: any,
  lua: any,
  lauxlib: any,
  to_luastring: (s: string) => Uint8Array,
  to_jsstring: (s: Uint8Array) => string,
): number {
  if (lua.lua_isnoneornil(L, 1)) {
    return lauxlib.luaL_error(L, to_luastring("render expects a template string"));
  }
  if (!lua.lua_istable(L, 2)) {
    return lauxlib.luaL_error(L, to_luastring("render expects a variables table"));
  }
  const template = to_jsstring(lua.lua_tostring(L, 1));
  try {
    const rendered = renderTemplate(template, (name) => {
      lua.lua_getfield(L, 2, to_luastring(name));
      if (lua.lua_isnil(L, -1) || lua.lua_isnoneornil(L, -1)) {
        lua.lua_pop(L, 1);
        return undefined;
      }
      lauxlib.luaL_tolstring(L, -1);
      const value = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 2);
      return value;
    });
    lua.lua_pushstring(L, to_luastring(rendered));
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return lauxlib.luaL_error(L, to_luastring(message));
  }
}

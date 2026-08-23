import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInitialState, createTab, defaultTabTitle } from "./defaults.js";
import { isKnownThinkingLevel } from "./thinking-levels.js";
import type { MixCodeState, MixCodeTabInfo, WorkspaceSnapshot } from "./types.js";

export function stateFileForPort(stateDir: string, port: number): string {
  return port === 0
    ? path.join(stateDir, "mixcode_state.json")
    : path.join(stateDir, `mixcode_state_${port}.json`);
}

export function scopedStateDir(stateDir: string, workdir: string): string {
  const normalized = normalizeStartupWorkdir(workdir);
  const digest = new Bun.CryptoHasher("sha256").update(normalized).digest("hex").slice(0, 16);
  return path.join(stateDir, "workdirs", digest);
}

export function normalizeStartupWorkdir(workdir: string): string {
  return workdir.trim().replace(/\/+$/, "");
}

export function serializeState(state: MixCodeState): Record<string, unknown> {
  // Open tabs, per-tab workdirs, custom titles, and unread-done flags.
  return {
    children: state.tabs.map((tab) => tab.sessionId),
    workdirs: Object.fromEntries(state.tabs.map((tab) => [tab.sessionId, tab.workdir])),
    tab_titles: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.title !== defaultTabTitle(tab.index))
        .map((tab) => [tab.sessionId, tab.title]),
    ),
    startup_workdir: state.workdir,
    unseen_done: state.tabs.filter((tab) => tab.unreadDone).map((tab) => tab.sessionId),
  };
}

export function deserializeState(
  data: Record<string, unknown>,
  fallbackWorkdir: string,
): MixCodeState {
  const state = createInitialState(
    typeof data.startup_workdir === "string" ? data.startup_workdir : fallbackWorkdir,
  );
  const workdirs = objectRecord(data.workdirs);
  const titles = objectRecord(data.tab_titles);
  const unseen = new Set(Array.isArray(data.unseen_done) ? data.unseen_done.map(String) : []);
  if (Array.isArray(data.children)) {
    state.tabs = data.children
      .map(String)
      .filter((sessionId) => sessionId.trim())
      .map((sessionId, index) => {
        const storedTitle = titles[sessionId];
        const title = typeof storedTitle === "string" ? storedTitle.trim() : "";
        const overrides: Partial<MixCodeTabInfo> = {
          unreadDone: unseen.has(sessionId),
          ...(title ? { title } : {}),
        };
        return createTab(
          index + 1,
          sessionId,
          typeof workdirs[sessionId] === "string" ? workdirs[sessionId] : state.workdir,
          overrides,
        );
      });
  }
  return state;
}

function normalizeThinkingLevel(
  value: unknown,
  fallback: MixCodeState["thinkingLevel"],
): MixCodeState["thinkingLevel"] {
  return typeof value === "string" && isKnownThinkingLevel(value) ? value : fallback;
}

function normalizeThinkingLevelMap(
  value: unknown,
  fallback: MixCodeState["model"]["thinkingLevelMap"],
): MixCodeState["model"]["thinkingLevelMap"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | null] =>
        typeof entry[1] === "string" || entry[1] === null,
    ),
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function saveStateFile(
  filePath: string,
  state: MixCodeState,
): Promise<void> {
  const temp = tempFilePath(filePath);
  await Bun.write(temp, `${JSON.stringify(serializeState(state), null, 2)}\n`);
  await fs.rename(temp, filePath);
}

export async function loadStateFile(
  filePath: string,
  fallbackWorkdir: string,
): Promise<MixCodeState> {
  const raw = await Bun.file(filePath).text();
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid state file: ${filePath}`);
  }
  return deserializeState(parsed as Record<string, unknown>, fallbackWorkdir);
}

export async function saveWorkspaces(
  filePath: string,
  workspaces: WorkspaceSnapshot[],
): Promise<void> {
  const cleaned = workspaces
    .filter((item) => item.name.trim())
    .map((item) => ({
      name: item.name.trim(),
      startup_workdir: normalizeStartupWorkdir(item.startupWorkdir),
      updated_at: item.updatedAt,
      active_session_id: item.activeSessionId,
      tabs: item.tabs
        .filter((tab) => tab.sessionId.trim())
        .map((tab) => ({
          session_id: tab.sessionId.trim(),
          session_path: tab.sessionPath?.trim() || undefined,
          title: tab.title,
          workdir: normalizeStartupWorkdir(tab.workdir),
          model: tab.model
            ? {
                provider: tab.model.provider,
                model_id: tab.model.modelId,
                display_name: tab.model.displayName,
                context_window: tab.model.contextWindow,
                reasoning: tab.model.reasoning,
                thinking_level_map: tab.model.thinkingLevelMap,
              }
            : undefined,
          thinking_level: tab.thinkingLevel,
        })),
    }));
  const temp = tempFilePath(filePath);
  await Bun.write(temp, `${JSON.stringify(cleaned, null, 2)}\n`);
  await fs.rename(temp, filePath);
}

function tempFilePath(filePath: string): string {
  return `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
}

/** Load the tabs-only workspace schema; named records without `tabs` are invalid. */
export async function loadWorkspaces(filePath: string): Promise<WorkspaceSnapshot[]> {
  const raw = await Bun.file(filePath).text();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`Invalid workspace file: ${filePath}`);
  return parsed
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .filter((item) => typeof item.name === "string")
    .map((item, index) => {
      if (!Array.isArray(item.tabs)) {
        throw new Error(
          `Invalid workspace file: ${filePath}: workspaces[${index}].tabs must be an array`,
        );
      }
      return {
        name: String(item.name).trim(),
        startupWorkdir: normalizeStartupWorkdir(
          typeof item.startup_workdir === "string" ? item.startup_workdir : "",
        ),
        updatedAt: typeof item.updated_at === "string" ? item.updated_at : "",
        ...(typeof item.active_session_id === "string" && item.active_session_id.trim()
          ? { activeSessionId: item.active_session_id.trim() }
          : {}),
        tabs: item.tabs.flatMap((tab) => deserializeWorkspaceTab(tab)),
      };
    });
}

function deserializeWorkspaceTab(item: unknown): WorkspaceSnapshot["tabs"] {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const raw = item as Record<string, unknown>;
  const sessionId = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
  if (!sessionId) return [];
  const model = deserializeWorkspaceModel(raw.model);
  return [
    {
      sessionId,
      sessionPath:
        typeof raw.session_path === "string" && raw.session_path.trim()
          ? raw.session_path.trim()
          : undefined,
      title: typeof raw.title === "string" ? raw.title : sessionId,
      workdir: normalizeStartupWorkdir(typeof raw.workdir === "string" ? raw.workdir : ""),
      model,
      thinkingLevel:
        typeof raw.thinking_level === "string"
          ? normalizeThinkingLevel(raw.thinking_level, "medium")
          : undefined,
    },
  ];
}

function deserializeWorkspaceModel(item: unknown): WorkspaceSnapshot["tabs"][number]["model"] {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const raw = item as Record<string, unknown>;
  if (typeof raw.provider !== "string" || typeof raw.model_id !== "string") return undefined;
  const thinkingLevelMap = normalizeThinkingLevelMap(raw.thinking_level_map, undefined);
  return {
    provider: raw.provider,
    modelId: raw.model_id,
    displayName: typeof raw.display_name === "string" ? raw.display_name : raw.model_id,
    contextWindow: typeof raw.context_window === "number" ? raw.context_window : 0,
    ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

export async function deleteWorkspace(filePath: string, name: string): Promise<void> {
  const workspaces = await loadWorkspaces(filePath);
  const remaining = workspaces.filter((item) => item.name !== name);
  if (remaining.length === workspaces.length) {
    throw new Error(`Unknown workspace: ${name}`);
  }
  if (remaining.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await saveWorkspaces(filePath, remaining);
}

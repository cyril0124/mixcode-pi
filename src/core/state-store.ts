import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createInitialState, createTab } from "./defaults.js";
import { normalizeGoal } from "./goal.js";
import { setTheme } from "./theme-registry.js";
import type {
  MixCodeState,
  PreviewMessage,
  PreviewMessageRole,
  WorkspaceSnapshot,
} from "./types.js";

export function stateFileForPort(stateDir: string, port: number): string {
  return port === 0
    ? join(stateDir, "mixcode_state.json")
    : join(stateDir, `mixcode_state_${port}.json`);
}

export function scopedStateDir(stateDir: string, workdir: string): string {
  const normalized = normalizeStartupWorkdir(workdir);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(stateDir, "workdirs", digest);
}

export function normalizeStartupWorkdir(workdir: string): string {
  return workdir.trim().replace(/\/+$/, "");
}

export function serializeState(state: MixCodeState, port: number): Record<string, unknown> {
  return {
    port,
    main_session_id: state.mainSessionId,
    children: state.tabs.map((tab) => tab.sessionId),
    model: state.model,
    variant: state.thinkingLevel,
    active_tab: state.activeTabId,
    workdirs: Object.fromEntries(state.tabs.map((tab) => [tab.sessionId, tab.workdir])),
    tab_titles: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.title !== defaultTabTitle(tab.index))
        .map((tab) => [tab.sessionId, tab.title]),
    ),
    tab_aliases: Object.fromEntries(
      state.tabs.filter((tab) => tab.alias).map((tab) => [tab.sessionId, tab.alias]),
    ),
    tab_models: Object.fromEntries(
      state.tabs
        .filter((tab) => !sameModelRef(tab.model, state.model))
        .map((tab) => [tab.sessionId, tab.model]),
    ),
    tab_variants: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.thinkingLevel !== state.thinkingLevel)
        .map((tab) => [tab.sessionId, tab.thinkingLevel]),
    ),
    preview_messages: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.previewMessages.length > 0)
        .map((tab) => [tab.sessionId, tab.previewMessages]),
    ),
    preview_indices: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.previewIndex > 0)
        .map((tab) => [tab.sessionId, tab.previewIndex]),
    ),
    preview_scroll_offsets: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.previewScrollOffset > 0)
        .map((tab) => [tab.sessionId, tab.previewScrollOffset]),
    ),
    chat_scroll_offsets: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.chatScrollOffset > 0)
        .map((tab) => [tab.sessionId, tab.chatScrollOffset]),
    ),
    shell_scroll_offsets: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.shellScrollOffset > 0)
        .map((tab) => [tab.sessionId, tab.shellScrollOffset]),
    ),
    pending_messages: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.pendingMessages.length > 0)
        .map((tab) => [tab.sessionId, tab.pendingMessages]),
    ),
    goals: Object.fromEntries(
      state.tabs.filter((tab) => tab.goal).map((tab) => [tab.sessionId, tab.goal]),
    ),
    redo_sessions: Object.fromEntries(
      state.tabs
        .filter((tab) => tab.redoSessionId)
        .map((tab) => [tab.sessionId, tab.redoSessionId]),
    ),
    startup_workdir: state.workdir,
    theme: state.theme,
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
  state.mainSessionId = typeof data.main_session_id === "string" ? data.main_session_id : "";
  state.activeTabId = typeof data.active_tab === "string" ? data.active_tab : "config";
  if (typeof data.theme === "string") setTheme(state, data.theme);
  if (data.model && typeof data.model === "object" && !Array.isArray(data.model)) {
    state.model = { ...state.model, ...(data.model as Partial<typeof state.model>) };
  }
  if (
    data.variant === "off" ||
    data.variant === "minimal" ||
    data.variant === "low" ||
    data.variant === "medium" ||
    data.variant === "high" ||
    data.variant === "xhigh"
  ) {
    state.thinkingLevel = data.variant;
  }
  const workdirs = objectRecord(data.workdirs);
  const titles = objectRecord(data.tab_titles);
  const aliases = objectRecord(data.tab_aliases);
  const tabModels = objectRecord(data.tab_models);
  const tabVariants = objectRecord(data.tab_variants);
  const previewMessages = objectRecord(data.preview_messages);
  const previewIndices = objectRecord(data.preview_indices);
  const previewScrollOffsets = objectRecord(data.preview_scroll_offsets);
  const chatScrollOffsets = objectRecord(data.chat_scroll_offsets);
  const shellScrollOffsets = objectRecord(data.shell_scroll_offsets);
  const pendingMessages = objectRecord(data.pending_messages);
  const goals = objectRecord(data.goals);
  const redoSessions = objectRecord(data.redo_sessions);
  const unseen = new Set(Array.isArray(data.unseen_done) ? data.unseen_done.map(String) : []);
  if (Array.isArray(data.children)) {
    state.tabs = data.children
      .map(String)
      .filter((sessionId) => sessionId.trim())
      .map((sessionId, index) => {
        const model = normalizeModelRef(tabModels[sessionId], state.model);
        const thinkingLevel = normalizeThinkingLevel(tabVariants[sessionId], state.thinkingLevel);
        const overrides = {
          alias: typeof aliases[sessionId] === "string" ? aliases[sessionId] : "",
          unreadDone: unseen.has(sessionId),
          previewMessages: normalizePreviewMessages(previewMessages[sessionId]),
          previewIndex:
            typeof previewIndices[sessionId] === "number" ? previewIndices[sessionId] : 0,
          previewScrollOffset:
            typeof previewScrollOffsets[sessionId] === "number"
              ? previewScrollOffsets[sessionId]
              : 0,
          chatScrollOffset:
            typeof chatScrollOffsets[sessionId] === "number" ? chatScrollOffsets[sessionId] : 0,
          shellScrollOffset:
            typeof shellScrollOffsets[sessionId] === "number" ? shellScrollOffsets[sessionId] : 0,
          pendingMessages: normalizeStringList(pendingMessages[sessionId]),
          goal: normalizeGoal(goals[sessionId]),
          redoSessionId:
            typeof redoSessions[sessionId] === "string" && redoSessions[sessionId]
              ? redoSessions[sessionId]
              : undefined,
          thinkingLevel,
          model,
          contextLimit: model.contextWindow,
        };
        return createTab(
          index + 1,
          sessionId,
          typeof workdirs[sessionId] === "string" ? workdirs[sessionId] : state.workdir,
          typeof titles[sessionId] === "string"
            ? { ...overrides, title: titles[sessionId] }
            : overrides,
        );
      });
  }
  return state;
}

function defaultTabTitle(index: number): string {
  return `Agent-${String(index).padStart(2, "0")}`;
}

function sameModelRef(left: MixCodeState["model"], right: MixCodeState["model"]): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

function normalizeModelRef(value: unknown, fallback: MixCodeState["model"]): MixCodeState["model"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const data = value as Record<string, unknown>;
  return {
    provider: typeof data.provider === "string" ? data.provider : fallback.provider,
    modelId: typeof data.modelId === "string" ? data.modelId : fallback.modelId,
    displayName: typeof data.displayName === "string" ? data.displayName : fallback.displayName,
    contextWindow:
      typeof data.contextWindow === "number" && Number.isFinite(data.contextWindow)
        ? data.contextWindow
        : fallback.contextWindow,
  };
}

function normalizeThinkingLevel(
  value: unknown,
  fallback: MixCodeState["thinkingLevel"],
): MixCodeState["thinkingLevel"] {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return fallback;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter((item) => item.trim());
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizePreviewMessages(value: unknown): PreviewMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item): PreviewMessage => {
      const role: PreviewMessageRole =
        item.role === "assistant" ||
        item.role === "thinking" ||
        item.role === "tool" ||
        item.role === "system" ||
        item.role === "shell" ||
        item.role === "empty"
          ? item.role
          : "user";
      return { role, text: String(item.text ?? "") };
    })
    .filter((item) => item.text);
}

export async function saveStateFile(
  filePath: string,
  state: MixCodeState,
  port: number,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = tempFilePath(filePath);
  await writeFile(temp, `${JSON.stringify(serializeState(state, port), null, 2)}\n`, "utf8");
  await rename(temp, filePath);
}

export async function loadStateFile(
  filePath: string,
  fallbackWorkdir: string,
): Promise<MixCodeState> {
  const raw = await readFile(filePath, "utf8");
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
  await mkdir(dirname(filePath), { recursive: true });
  const cleaned = workspaces
    .filter((item) => item.name.trim())
    .map((item) => ({
      name: item.name.trim(),
      children: item.children.filter((child) => child.trim()),
      startup_workdir: normalizeStartupWorkdir(item.startupWorkdir),
      updated_at: item.updatedAt,
    }));
  const temp = tempFilePath(filePath);
  await writeFile(temp, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
  await rename(temp, filePath);
}

function tempFilePath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

export async function loadWorkspaces(filePath: string): Promise<WorkspaceSnapshot[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`Invalid workspace file: ${filePath}`);
  return parsed
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .filter((item) => typeof item.name === "string" && Array.isArray(item.children))
    .map((item) => ({
      name: String(item.name).trim(),
      children: (item.children as unknown[]).map(String).filter((child) => child.trim()),
      startupWorkdir: normalizeStartupWorkdir(
        typeof item.startup_workdir === "string" ? item.startup_workdir : "",
      ),
      updatedAt: typeof item.updated_at === "string" ? item.updated_at : "",
    }));
}

export async function deleteWorkspace(filePath: string, name: string): Promise<void> {
  const remaining = (await loadWorkspaces(filePath)).filter((item) => item.name !== name);
  if (remaining.length === 0) {
    await rm(filePath, { force: true });
    return;
  }
  await saveWorkspaces(filePath, remaining);
}

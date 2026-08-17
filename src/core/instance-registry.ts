import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HOME_TAB_ID, type MixCodeState, type TabStatus } from "./types.js";

export const INSTANCE_REGISTRY_VERSION = 1;
export const INSTANCE_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_INSTANCE_STALE_AFTER_MS = 15_000;

export type InstanceTabState = "waiting-for-input" | "error" | "working" | "finished" | "idle";

export interface ProcessIdentity {
  alive: boolean;
}

export interface InstanceRegistryTabSnapshot {
  index: number;
  sessionId: string;
  title: string;
  workdir: string;
  status: TabStatus;
  unreadDone: boolean;
  waitingForInputCount: number;
}

export interface InstanceRegistrySnapshot {
  version: typeof INSTANCE_REGISTRY_VERSION;
  pid: number;
  workdir: string;
  activeTabId: string;
  updatedAt: string;
  tabs: InstanceRegistryTabSnapshot[];
}

export interface InstanceStatusTab extends InstanceRegistryTabSnapshot {
  active: boolean;
  state: InstanceTabState;
  shortSessionId: string;
}

export interface InstanceStatusInstance extends Omit<InstanceRegistrySnapshot, "tabs"> {
  activeLabel: string;
  stale: false;
  tabs: InstanceStatusTab[];
}

export interface InstanceStatusWarning {
  file: string;
  message: string;
}

export interface InstanceStatusReport {
  generatedAt: string;
  instances: InstanceStatusInstance[];
  warnings: InstanceStatusWarning[];
}

export interface LoadInstanceStatusOptions {
  now?: Date;
  staleAfterMs?: number;
  processInfo?: (pid: number) => ProcessIdentity;
  workdir?: string;
}

export interface CleanupInstanceRegistryResult {
  removed: number[];
  removedFiles: string[];
  warnings: InstanceStatusWarning[];
}

const VALID_TAB_STATUSES = new Set<TabStatus>([
  "Not Ready",
  "idle",
  "running",
  "thinking",
  "error",
  "done",
]);

export function instanceRegistryDir(rootStateDir: string): string {
  return path.join(rootStateDir, "instances");
}

export function instanceRegistryFile(rootStateDir: string, pid = process.pid): string {
  return path.join(instanceRegistryDir(rootStateDir), `${pid}.json`);
}

export function instanceCtlSocketFile(rootStateDir: string, pid = process.pid): string {
  return path.join(instanceRegistryDir(rootStateDir), `${pid}.sock`);
}

export function createInstanceSnapshot(
  state: MixCodeState,
  options: { now?: Date; pid?: number } = {},
): InstanceRegistrySnapshot {
  const pid = options.pid ?? process.pid;
  return {
    version: INSTANCE_REGISTRY_VERSION,
    pid,
    workdir: normalizeWorkdir(state.workdir),
    activeTabId: state.activeTabId,
    updatedAt: (options.now ?? new Date()).toISOString(),
    tabs: state.tabs
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((tab) => ({
        index: tab.index,
        sessionId: tab.sessionId,
        title: tab.title,
        workdir: normalizeWorkdir(tab.workdir),
        status: tab.status,
        unreadDone: tab.unreadDone,
        waitingForInputCount: tab.extensionUi.waitingForInputs.length,
      })),
  };
}

export async function writeCurrentInstanceSnapshot(
  rootStateDir: string,
  state: MixCodeState,
  options: { now?: Date; pid?: number } = {},
): Promise<void> {
  await writeInstanceSnapshot(rootStateDir, createInstanceSnapshot(state, options));
}

export async function writeInstanceSnapshot(
  rootStateDir: string,
  snapshot: InstanceRegistrySnapshot,
): Promise<void> {
  const filePath = instanceRegistryFile(rootStateDir, snapshot.pid);
  const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temp, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.rename(temp, filePath);
}

export function removeInstanceSnapshotSync(rootStateDir: string, pid = process.pid): void {
  fsSync.rmSync(instanceRegistryFile(rootStateDir, pid), { force: true });
  fsSync.rmSync(instanceCtlSocketFile(rootStateDir, pid), { force: true });
}

export async function loadLiveInstanceStatus(
  rootStateDir: string,
  options: LoadInstanceStatusOptions = {},
): Promise<InstanceStatusReport> {
  const now = options.now ?? new Date();
  const warnings: InstanceStatusWarning[] = [];
  const instances: InstanceStatusInstance[] = [];
  for (const filePath of await listRegistryFiles(rootStateDir)) {
    const parsed = await readSnapshotFile(filePath);
    if (parsed.warning) {
      warnings.push(parsed.warning);
      continue;
    }
    const snapshot = parsed.snapshot;
    if (!snapshot) continue;
    if (options.workdir && normalizeWorkdir(snapshot.workdir) !== normalizeWorkdir(options.workdir)) {
      continue;
    }
    if (!snapshotIsLive(snapshot, now, options)) continue;
    instances.push(resolveStatusInstance(snapshot, now));
  }
  instances.sort((a, b) => a.workdir.localeCompare(b.workdir) || a.pid - b.pid);
  return { generatedAt: now.toISOString(), instances, warnings };
}

export async function cleanupInstanceRegistry(
  rootStateDir: string,
  options: LoadInstanceStatusOptions = {},
): Promise<CleanupInstanceRegistryResult> {
  const now = options.now ?? new Date();
  const removed: number[] = [];
  const removedFiles: string[] = [];
  const warnings: InstanceStatusWarning[] = [];
  for (const filePath of await listRegistryFiles(rootStateDir)) {
    const parsed = await readSnapshotFile(filePath);
    if (parsed.warning) {
      warnings.push(parsed.warning);
      continue;
    }
    const snapshot = parsed.snapshot;
    if (!snapshot) continue;
    if (snapshotIsLive(snapshot, now, options)) continue;
    await fs.rm(filePath, { force: true });
    removed.push(snapshot.pid);
    removedFiles.push(filePath);
  }
  return { removed, removedFiles, warnings };
}

export function formatDisplayWorkdir(workdir: string, home = os.homedir()): string {
  if (workdir === home) return "~";
  if (workdir.startsWith(`${home}/`) || (process.platform === "win32" && workdir.startsWith(`${home}\\`))) {
    return `~${workdir.slice(home.length)}`;
  }
  return workdir;
}

export function formatInstanceStatusJson(report: InstanceStatusReport): string {
  const data = {
    instances: report.instances.map((instance) => {
      const activeTab = instance.tabs.find((tab) => tab.active);
      const activeTabTitle =
        activeTab?.title ?? (instance.activeTabId === HOME_TAB_ID ? "home" : undefined);
      return {
        pid: instance.pid,
        workdir: formatDisplayWorkdir(instance.workdir),
        ...(activeTabTitle !== undefined ? { activeTabTitle } : {}),
        tabs: instance.tabs.map((tab) => ({
          state: tab.state,
          status: tab.status,
          tabTitle: tab.title,
          sessionId: tab.sessionId,
        })),
      };
    }),
  };
  return JSON.stringify(data, null, 2);
}

export function formatInstanceStatusTable(report: InstanceStatusReport): string {
  if (report.instances.length === 0) return "No live mpi instances.";
  const maxTitleLen = report.instances
    .flatMap((i) => i.tabs)
    .reduce((max, t) => Math.max(max, t.title.length), "TAB_TITLE".length);

  const groups: string[] = [];
  for (const instance of report.instances) {
    const lines = [
      `PID ${instance.pid}  workdir: ${formatDisplayWorkdir(instance.workdir)}`,
      `  A  STATE        STATUS     ${pad("TAB_TITLE", maxTitleLen)}  SESSION`,
      ...instance.tabs.map((tab) => formatStatusTabRow(tab, maxTitleLen)),
    ];
    groups.push(lines.join("\n"));
  }
  return `${groups.join("\n\n")}\n\n  (* = focused tab)`;
}

export function currentProcessIdentity(pid = process.pid): ProcessIdentity {
  return { alive: pidIsAlive(pid) };
}

function formatStatusTabRow(tab: InstanceStatusTab, titleWidth = 14): string {
  const active = tab.active ? "*" : " ";
  return [
    `  ${active}`,
    pad(tab.state, 12),
    pad(tab.status, 10),
    pad(tab.title, titleWidth),
    tab.sessionId,
  ].join(" ");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function resolveStatusInstance(
  snapshot: InstanceRegistrySnapshot,
  now: Date,
): InstanceStatusInstance {
  const tabs = snapshot.tabs
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((tab) => resolveStatusTab(tab, snapshot.activeTabId, now));
  return {
    ...snapshot,
    stale: false,
    activeLabel: snapshot.activeTabId === HOME_TAB_ID ? "home" : snapshot.activeTabId,
    tabs,
  };
}

function resolveStatusTab(
  tab: InstanceRegistryTabSnapshot,
  activeTabId: string,
  _now: Date,
): InstanceStatusTab {
  return {
    ...tab,
    active: tab.sessionId === activeTabId,
    state: deriveTabState(tab),
    shortSessionId: shortSessionId(tab.sessionId),
  };
}

function deriveTabState(tab: InstanceRegistryTabSnapshot): InstanceTabState {
  if (tab.waitingForInputCount > 0) return "waiting-for-input";
  if (tab.status === "error") return "error";
  if (tab.status === "running" || tab.status === "thinking") return "working";
  if (tab.status === "done" || tab.unreadDone) return "finished";
  return "idle";
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}

function snapshotIsLive(
  snapshot: InstanceRegistrySnapshot,
  now: Date,
  options: LoadInstanceStatusOptions,
): boolean {
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_INSTANCE_STALE_AFTER_MS;
  if (now.getTime() - updatedAt > staleAfterMs) return false;
  const identity = options.processInfo?.(snapshot.pid) ?? currentProcessIdentity(snapshot.pid);
  return identity.alive;
}

async function listRegistryFiles(rootStateDir: string): Promise<string[]> {
  const dir = instanceRegistryDir(rootStateDir);
  // Name-only filter: avoid Dirent.isFile()/lstat. On NFS, readdir can list a
  // writeInstanceSnapshot temp (*.json.<pid>.<uuid>.tmp) that is renamed away
  // before isFile runs, throwing ENOENT into peer-tab-sync.
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => path.join(dir, name));
}

async function readSnapshotFile(filePath: string): Promise<{
  snapshot?: InstanceRegistrySnapshot;
  warning?: InstanceStatusWarning;
}> {
  try {
    const raw = await Bun.file(filePath).text();
    return { snapshot: parseSnapshot(JSON.parse(raw), filePath) };
  } catch (error) {
    return { warning: { file: filePath, message: error instanceof Error ? error.message : String(error) } };
  }
}

function parseSnapshot(value: unknown, filePath: string): InstanceRegistrySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid instance registry file: ${filePath}`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== INSTANCE_REGISTRY_VERSION) {
    throw new Error(`Unsupported instance registry version in ${filePath}`);
  }
  const pid = numberField(raw, "pid", filePath);
  const snapshot: InstanceRegistrySnapshot = {
    version: INSTANCE_REGISTRY_VERSION,
    pid,
    workdir: normalizeWorkdir(stringField(raw, "workdir", filePath)),
    activeTabId: stringField(raw, "activeTabId", filePath),
    updatedAt: stringField(raw, "updatedAt", filePath),
    tabs: arrayField(raw, "tabs", filePath).map((tab, index) => parseTabSnapshot(tab, filePath, index)),
  };
  return snapshot;
}

function parseTabSnapshot(
  value: unknown,
  filePath: string,
  index: number,
): InstanceRegistryTabSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid tab entry ${index} in ${filePath}`);
  }
  const raw = value as Record<string, unknown>;
  const status = stringField(raw, "status", filePath);
  if (!VALID_TAB_STATUSES.has(status as TabStatus)) {
    throw new Error(`Invalid tab status '${status}' in ${filePath}`);
  }
  return {
    index: numberField(raw, "index", filePath),
    sessionId: stringField(raw, "sessionId", filePath),
    title: stringField(raw, "title", filePath),
    workdir: normalizeWorkdir(stringField(raw, "workdir", filePath)),
    status: status as TabStatus,
    unreadDone: booleanField(raw, "unreadDone", filePath),
    waitingForInputCount: numberField(raw, "waitingForInputCount", filePath),
  };
}

function stringField(raw: Record<string, unknown>, key: string, filePath: string): string {
  const value = raw[key];
  if (typeof value !== "string") throw new Error(`Invalid '${key}' in ${filePath}`);
  return value;
}

function numberField(raw: Record<string, unknown>, key: string, filePath: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid '${key}' in ${filePath}`);
  }
  return value;
}

function booleanField(raw: Record<string, unknown>, key: string, filePath: string): boolean {
  const value = raw[key];
  if (typeof value !== "boolean") throw new Error(`Invalid '${key}' in ${filePath}`);
  return value;
}

function arrayField(raw: Record<string, unknown>, key: string, filePath: string): unknown[] {
  const value = raw[key];
  if (!Array.isArray(value)) throw new Error(`Invalid '${key}' in ${filePath}`);
  return value;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function normalizeWorkdir(workdir: string): string {
  return workdir.trim().replace(/\/+$/, "");
}

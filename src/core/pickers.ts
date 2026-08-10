import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { contextLimitPickerItems } from "./context-limit.js";
import { fuzzyMatch } from "./fuzzy.js";
import { modelRefId } from "./models.js";
import { availableThinkingLevelsForModel } from "./thinking-levels.js";
import type { MixCodeState, MixCodeTabInfo, PickerItem, PickerKind, PickerState } from "./types.js";

export function createPicker(
  kind: PickerKind,
  state: MixCodeState,
  active?: MixCodeTabInfo,
): PickerState {
  const items = pickerItems(kind, state, active);
  const selectedId = selectedPickerId(kind, state, active);
  const browsingDir = kind === "workdir" ? (active?.workdir ?? state.workdir) : undefined;
  return {
    kind,
    title: pickerTitle(kind),
    query: "",
    selectedIndex: kind === "workdir" ? 0 : selectedPickerIndex(items, selectedId),
    items,
    workdirBase: browsingDir,
    browsingDir,
    showHidden: false,
  };
}

export function pickerItems(
  kind: PickerKind,
  state: MixCodeState,
  active?: MixCodeTabInfo,
): PickerItem[] {
  if (kind === "models") {
    return state.availableModels.map((model) => ({
      id: modelRefId(model),
      label: model.displayName,
      description: model.disabled
        ? `disabled · ${model.contextWindow} context`
        : `${model.contextWindow} context`,
      ...(model.disabled ? { disabled: true as const } : {}),
    }));
  }
  if (kind === "thinking") {
    return availableThinkingLevelsForModel(active?.model ?? state.model).map((level) => ({
      id: level,
      label: level,
      description: active?.thinkingLevel === level ? "current" : "thinking tier",
    }));
  }
  if (kind === "context-limit") {
    const contextWindow = active?.model.contextWindow ?? state.model.contextWindow;
    return contextLimitPickerItems(contextWindow);
  }
  return [
    {
      id: active?.workdir ?? state.workdir,
      label: active?.workdir ?? state.workdir,
      description: "current workdir",
    },
  ];
}

export function filteredPickerItems(picker: PickerState): PickerItem[] {
  const query = picker.query.trim();
  if (picker.kind === "workdir") return filteredWorkdirItems(picker, query);
  if (!query) return picker.items;
  const matches = picker.items
    .map((item) => ({
      item,
      score: Math.min(
        fuzzyMatch(query, item.id) ?? Number.POSITIVE_INFINITY,
        fuzzyMatch(query, item.label) ?? Number.POSITIVE_INFINITY,
      ),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label))
    .map((entry) => entry.item);
  return matches;
}

export function updatePickerQuery(picker: PickerState, query: string): void {
  picker.query = query;
  filteredPickerItems(picker);
  picker.selectedIndex = 0;
}

export function movePickerSelection(picker: PickerState, delta: number): void {
  const count = filteredPickerItems(picker).length;
  if (count === 0) {
    picker.selectedIndex = 0;
    return;
  }
  picker.selectedIndex = (picker.selectedIndex + delta + count) % count;
}

export function acceptPickerSelection(picker: PickerState): PickerItem | undefined {
  return filteredPickerItems(picker)[picker.selectedIndex];
}

export function completeWorkdirPickerSelection(picker: PickerState): boolean {
  if (picker.kind !== "workdir") return false;
  const selected = acceptPickerSelection(picker);
  if (!selected?.completeValue) return false;
  // Navigate into the selected directory
  picker.browsingDir = selected.completeValue;
  picker.query = "";
  picker.selectedIndex = 0;
  return true;
}

/** Navigate the workdir picker to the parent directory */
export function navigatePickerToParent(picker: PickerState): boolean {
  if (picker.kind !== "workdir" || !picker.browsingDir) return false;
  const parent = path.dirname(picker.browsingDir);
  if (parent === picker.browsingDir) return false; // already at root
  const currentName = path.basename(picker.browsingDir);
  picker.browsingDir = parent;
  picker.query = "";
  // Try to select the directory we came from
  const items = filteredPickerItems(picker);
  const idx = items.findIndex((item) => item.label === `${currentName}/`);
  picker.selectedIndex = idx >= 0 ? idx : 0;
  return true;
}

/** Toggle visibility of hidden directories in the workdir picker */
export function togglePickerHidden(picker: PickerState): boolean {
  if (picker.kind !== "workdir") return false;
  picker.showHidden = !picker.showHidden;
  picker.selectedIndex = 0;
  return true;
}

/** Get the breadcrumb segments for the current browsing directory */
export function workdirBreadcrumb(picker: PickerState): string[] {
  if (picker.kind !== "workdir" || !picker.browsingDir) return [];
  const dir = picker.browsingDir;
  const home = (process.env.HOME || os.homedir());
  if (dir === home) return ["~"];
  if (dir.startsWith(home + "/")) {
    return [
      "~",
      ...dir
        .slice(home.length + 1)
        .split("/")
        .filter(Boolean),
    ];
  }
  // Absolute path: split into segments, first segment is "/"
  const parts = dir.split("/").filter(Boolean);
  return ["/", ...parts];
}

function pickerTitle(kind: PickerKind): string {
  if (kind === "models") return "Choose Model";
  if (kind === "thinking") return "Choose Thinking";
  if (kind === "context-limit") return "Set Context Limit";
  return "Change Workdir";
}

function selectedPickerId(kind: PickerKind, state: MixCodeState, active?: MixCodeTabInfo): string {
  if (kind === "models") return modelRefId(active?.model ?? state.model);
  if (kind === "thinking") return active?.thinkingLevel ?? state.thinkingLevel;
  return active?.workdir ?? state.workdir;
}

function selectedPickerIndex(items: PickerItem[], selectedId: string): number {
  return Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  );
}

function filteredWorkdirItems(picker: PickerState, query: string): PickerItem[] {
  const browsingDir = picker.browsingDir ?? picker.workdirBase ?? process.cwd();
  const showHidden = picker.showHidden ?? false;

  // If query looks like a path (contains / or starts with ~), treat as direct path input
  if (query && (query.includes("/") || query.startsWith("~"))) {
    const resolved = normalizeWorkdirInput(browsingDir, query);
    return [{ id: resolved, label: query, description: "custom path" }];
  }

  const listing = workdirDirectoryListing(picker, browsingDir, showHidden);
  if ("error" in listing) {
    return [{ id: browsingDir, label: browsingDir, description: `error: ${listing.error}` }];
  }

  const needle = query.toLowerCase();
  const filtered = needle
    ? listing.dirs.filter((name) => name.toLowerCase().includes(needle))
    : listing.dirs;

  return filtered.map((name) => ({
    id: path.resolve(browsingDir, name),
    label: `${name}/`,
    description: "directory",
    completeValue: path.resolve(browsingDir, name),
  }));
}

/** Sorted directory names for browsingDir; cached on the picker across query keystrokes. */
function workdirDirectoryListing(
  picker: PickerState,
  browsingDir: string,
  showHidden: boolean,
): { dirs: string[] } | { error: string } {
  const cache = picker.workdirListingCache;
  if (cache && cache.browsingDir === browsingDir && cache.showHidden === showHidden) {
    if (cache.error) return { error: cache.error };
    return { dirs: cache.dirs };
  }

  const entries = readDirectoryEntries(browsingDir);
  if ("error" in entries) {
    picker.workdirListingCache = { browsingDir, showHidden, dirs: [], error: entries.error };
    return { error: entries.error };
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  picker.workdirListingCache = { browsingDir, showHidden, dirs };
  return { dirs };
}

/** Resolve ~ / relative / absolute workdir input against a base directory. */
export function normalizeWorkdirInput(base: string, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return path.resolve(base);
  if (trimmed === "~") return (process.env.HOME || os.homedir());
  if (trimmed.startsWith("~/")) return path.join((process.env.HOME || os.homedir()), trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return path.resolve(base, trimmed);
}

function readDirectoryEntries(
  dirPath: string,
): Array<{ name: string; isDirectory: () => boolean }> | { error: string } {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return { error: `parent unreadable: ${dirPath} (${code})` };
  }
}

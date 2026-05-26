import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { THEMES } from "../ui/themes.js";
import { fuzzyMatch } from "./fuzzy.js";
import { modelRefId } from "./models.js";
import type { MixCodeState, MixCodeTabInfo, PickerItem, PickerKind, PickerState } from "./types.js";

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

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
      description: `${model.contextWindow} context`,
    }));
  }
  if (kind === "thinking") {
    return THINKING_LEVELS.map((level) => ({
      id: level,
      label: level,
      description: active?.thinkingLevel === level ? "current" : "thinking tier",
    }));
  }
  if (kind === "theme") {
    return THEMES.map((theme) => ({
      id: theme.id,
      label: theme.label,
      description: theme.dark ? "dark" : "light",
    }));
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
  picker.selectedIndex = Math.min(
    picker.selectedIndex,
    Math.max(0, filteredPickerItems(picker).length - 1),
  );
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
  const parent = dirname(picker.browsingDir);
  if (parent === picker.browsingDir) return false; // already at root
  const currentName = basename(picker.browsingDir);
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
  const home = homedir();
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
  if (kind === "theme") return "Choose Theme";
  return "Change Workdir";
}

function selectedPickerId(kind: PickerKind, state: MixCodeState, active?: MixCodeTabInfo): string {
  if (kind === "models") return modelRefId(active?.model ?? state.model);
  if (kind === "thinking") return active?.thinkingLevel ?? state.thinkingLevel;
  if (kind === "theme") return state.theme;
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

  const entries = readDirectoryEntries(browsingDir);
  if ("error" in entries) {
    return [{ id: browsingDir, label: browsingDir, description: `error: ${entries.error}` }];
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const filtered = query
    ? dirs.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
    : dirs;

  return filtered.slice(0, 20).map((entry) => ({
    id: resolve(browsingDir, entry.name),
    label: `${entry.name}/`,
    description: "directory",
    completeValue: resolve(browsingDir, entry.name),
  }));
}

function normalizeWorkdirInput(base: string, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return resolve(base);
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed)) return resolve(trimmed);
  return resolve(base, trimmed);
}

function readDirectoryEntries(
  path: string,
): Array<{ name: string; isDirectory: () => boolean }> | { error: string } {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return { error: `parent unreadable: ${path} (${code})` };
  }
}

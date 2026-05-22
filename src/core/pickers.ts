import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fuzzyMatch } from "./fuzzy.js";
import { modelRefId } from "./models.js";
import type { MixCodeState, MixCodeTabInfo, PickerItem, PickerKind, PickerState } from "./types.js";
import { THEMES } from "../ui/themes.js";

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
  return {
    kind,
    title: pickerTitle(kind),
    query: kind === "workdir" ? selectedId : "",
    selectedIndex: selectedPickerIndex(items, selectedId),
    items,
    workdirBase: kind === "workdir" ? (active?.workdir ?? state.workdir) : undefined,
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
  picker.query = selected.completeValue;
  picker.selectedIndex = 0;
  return true;
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
  const base = picker.workdirBase ?? picker.items[0]?.id ?? process.cwd();
  if (!query) return picker.items;
  const { candidates, error } = directoryCandidates(base, query);
  const custom = {
    id: normalizeWorkdirInput(base, query),
    label: query,
    description: error ? `custom workdir | ${error}` : "custom workdir",
  };
  if (query.endsWith("/")) {
    return [custom, ...candidates.filter((item) => item.id !== custom.id)];
  }
  return candidates.some((item) => item.id === custom.id) ? candidates : [...candidates, custom];
}

function directoryCandidates(
  base: string,
  query: string,
): { candidates: PickerItem[]; error: string } {
  const { parent, prefix, outputPrefix } = workdirQueryParts(base, query);
  const entries = readDirectoryEntries(parent);
  if ("error" in entries) return { candidates: [], error: entries.error };
  const matches = entries
    .filter((entry) => entry.isDirectory())
    .filter(
      (entry) =>
        !entry.name.startsWith(".") && entry.name.toLowerCase().startsWith(prefix.toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20);
  return {
    error: "",
    candidates: matches.map((entry) => {
      const value = `${outputPrefix}${entry.name}/`;
      return {
        id: normalizeWorkdirInput(base, value),
        label: value,
        description: "directory",
        completeValue: value,
      };
    }),
  };
}

function workdirQueryParts(
  base: string,
  query: string,
): { parent: string; prefix: string; outputPrefix: string } {
  const normalized = query.replace(/\\/g, "/");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex === -1) {
    return { parent: expandWorkdirBase(base, ""), prefix: normalized, outputPrefix: "" };
  }
  const rawParent = normalized.slice(0, slashIndex + 1);
  return {
    parent: expandWorkdirBase(base, rawParent),
    prefix: normalized.slice(slashIndex + 1),
    outputPrefix: rawParent,
  };
}

function normalizeWorkdirInput(base: string, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return resolve(base);
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed)) return resolve(trimmed);
  return resolve(base, trimmed);
}

function expandWorkdirBase(base: string, rawParent: string): string {
  if (!rawParent) return resolve(base);
  if (rawParent === "~/") return homedir();
  if (rawParent.startsWith("~/")) return resolve(homedir(), rawParent.slice(2));
  if (isAbsolute(rawParent)) return resolve(rawParent);
  return resolve(base, rawParent);
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

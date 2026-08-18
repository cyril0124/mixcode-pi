/**
 * Overlay for /auto-rename config.
 * Main list shows model / thinking / onFirstMessage / maxContextChars.
 * Enter on a value opens a picker; Enter on onFirstMessage toggles.
 * Changes persist immediately via onChange.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  AUTO_RENAME_INHERIT,
  DEFAULT_MAX_CONTEXT_CHARS,
  resolveMaxContextChars,
  type AutoRenameConfig,
} from "./config.js";

type ThemeLike = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
};

type Mode = "main" | "pick-model" | "pick-thinking" | "pick-max-context";
type MainRow = "model" | "thinking" | "onFirstMessage" | "maxContextChars";

const MAIN_ROWS: MainRow[] = ["model", "thinking", "onFirstMessage", "maxContextChars"];
const CONTEXT_CHAR_PRESETS = [1000, 4000, 8000, 16000];

export interface AutoRenameConfigOverlayOptions {
  theme: ThemeLike;
  requestRender: () => void;
  done: () => void;
  onChange?: (config: AutoRenameConfig) => void;
  initial: AutoRenameConfig;
  modelOptions: string[];
  thinkingOptions?: string[];
  getThinkingOptions?: (modelRef: string) => string[];
  getMaxVisible?: () => number;
}

export function createAutoRenameConfigOverlay(options: AutoRenameConfigOverlayOptions): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { theme, requestRender, done, onChange } = options;
  let draft: AutoRenameConfig = { ...options.initial };
  let mode: Mode = "main";
  let mainIndex = 0;
  let pickIndex = 0;
  let pickQuery = "";

  const modelOptions = uniqueOptions([AUTO_RENAME_INHERIT, ...options.modelOptions]);

  function currentThinkingOptions(): string[] {
    const extra = options.getThinkingOptions?.(currentModelLabel()) ?? options.thinkingOptions ?? [];
    return uniqueOptions([AUTO_RENAME_INHERIT, ...extra]);
  }

  function currentModelLabel(): string {
    return draft.model?.trim() || AUTO_RENAME_INHERIT;
  }

  function currentThinkingLabel(): string {
    return draft.thinking?.trim() || AUTO_RENAME_INHERIT;
  }

  function currentOnFirstLabel(): string {
    return draft.onFirstMessage === true ? "on" : "off";
  }

  function currentMaxContextLabel(): string {
    return String(resolveMaxContextChars(draft));
  }

  function contextCharOptions(): string[] {
    const current = resolveMaxContextChars(draft);
    const values = new Set(CONTEXT_CHAR_PRESETS);
    values.add(current);
    return [...values].sort((a, b) => a - b).map(String);
  }

  function commit(next: AutoRenameConfig): void {
    draft = next;
    onChange?.({ ...draft });
  }

  function setModel(value: string): void {
    if (!value || value === AUTO_RENAME_INHERIT) {
      const { model: _drop, ...rest } = draft;
      commit(rest);
      return;
    }
    commit({ ...draft, model: value });
  }

  function setThinking(value: string): void {
    if (!value || value === AUTO_RENAME_INHERIT) {
      const { thinking: _drop, ...rest } = draft;
      commit(rest);
      return;
    }
    commit({ ...draft, thinking: value });
  }

  function toggleOnFirst(): void {
    if (draft.onFirstMessage === true) {
      const { onFirstMessage: _drop, ...rest } = draft;
      commit(rest);
      return;
    }
    commit({ ...draft, onFirstMessage: true });
  }

  function setMaxContextChars(value: string): void {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed === DEFAULT_MAX_CONTEXT_CHARS) {
      const { maxContextChars: _drop, ...rest } = draft;
      commit(rest);
      return;
    }
    commit({ ...draft, maxContextChars: parsed });
  }

  function pickerOptions(next: Exclude<Mode, "main">): string[] {
    if (next === "pick-model") return modelOptions;
    if (next === "pick-thinking") return currentThinkingOptions();
    return contextCharOptions();
  }

  function filteredPickOptions(): string[] {
    if (mode === "main") return [];
    const all = pickerOptions(mode);
    const q = pickQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter((item) => item.toLowerCase().includes(q));
  }

  function openPicker(next: Exclude<Mode, "main">): void {
    mode = next;
    pickQuery = "";
    const list = pickerOptions(next);
    const current =
      next === "pick-model"
        ? currentModelLabel()
        : next === "pick-thinking"
          ? currentThinkingLabel()
          : currentMaxContextLabel();
    const idx = list.indexOf(current);
    pickIndex = idx >= 0 ? idx : 0;
    requestRender();
  }

  function handleMainInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      done();
      return;
    }
    if (matchesKey(data, "up")) {
      mainIndex = (mainIndex - 1 + MAIN_ROWS.length) % MAIN_ROWS.length;
      requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      mainIndex = (mainIndex + 1) % MAIN_ROWS.length;
      requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      const row = MAIN_ROWS[mainIndex];
      if (row === "model") openPicker("pick-model");
      else if (row === "thinking") openPicker("pick-thinking");
      else if (row === "maxContextChars") openPicker("pick-max-context");
      else {
        toggleOnFirst();
        requestRender();
      }
    }
  }

  function handlePickInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      mode = "main";
      pickQuery = "";
      requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      const count = filteredPickOptions().length;
      if (count > 0) pickIndex = (pickIndex - 1 + count) % count;
      requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      const count = filteredPickOptions().length;
      if (count > 0) pickIndex = (pickIndex + 1) % count;
      requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const opts = filteredPickOptions();
      const chosen = opts[Math.min(Math.max(pickIndex, 0), Math.max(0, opts.length - 1))];
      if (chosen) {
        if (mode === "pick-model") setModel(chosen);
        else if (mode === "pick-thinking") setThinking(chosen);
        else setMaxContextChars(chosen);
      }
      mode = "main";
      pickQuery = "";
      requestRender();
      return;
    }
    if (data === "\u007f" || matchesKey(data, "backspace")) {
      pickQuery = pickQuery.slice(0, -1);
      pickIndex = 0;
      requestRender();
      return;
    }
    if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
      pickQuery += data;
      pickIndex = 0;
      requestRender();
    }
  }

  function padLine(text: string, width: number): string {
    const singleLine = text.replace(/[\r\n]+/g, " ");
    const clipped =
      visibleWidth(singleLine) <= width ? singleLine : truncateToWidth(singleLine, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  function renderPanel(body: string[], width: number, panelTitle: string): string[] {
    const innerWidth = Math.max(0, width - 2);
    const title = ` ${panelTitle} `;
    const topFill = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
    const top = `${title}${topFill}`;
    const border = (text: string) => theme.fg("border", text);
    return [
      `${border("┌")}${border(padLine(top, innerWidth))}${border("┐")}`,
      ...body.map((line) => `${border("│")}${padLine(line, innerWidth)}${border("│")}`),
      `${border("└")}${border("─".repeat(innerWidth))}${border("┘")}`,
    ];
  }

  function renderMain(width: number): string[] {
    const rows: Array<{ label: string; value: string }> = [
      { label: "Model", value: currentModelLabel() },
      { label: "Thinking", value: currentThinkingLabel() },
      { label: "On first message", value: currentOnFirstLabel() },
      { label: "Max context chars", value: currentMaxContextLabel() },
    ];
    const body: string[] = [theme.fg("dim", " Changes apply immediately · Enter edit / toggle"), ""];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const selected = i === mainIndex;
      const pointer = selected ? theme.fg("accent", "› ") : "  ";
      const label = selected ? theme.fg("accent", row.label.padEnd(18)) : row.label.padEnd(18);
      const value = selected ? theme.fg("accent", row.value) : theme.fg("dim", row.value);
      body.push(`${pointer}${label} ${value}`);
    }
    body.push("");
    body.push(theme.fg("dim", " Esc close"));
    return renderPanel(body, width, "Auto-rename");
  }

  function renderPicker(width: number): string[] {
    const title =
      mode === "pick-model"
        ? "Select model"
        : mode === "pick-thinking"
          ? "Select thinking"
          : "Select max context chars";
    const opts = filteredPickOptions();
    const maxVisible = Math.max(3, options.getMaxVisible?.() ?? 10);
    const body: string[] = [
      theme.fg("dim", ` Filter: ${pickQuery.length > 0 ? pickQuery : "(type to filter)"} · applies on Enter`),
      "",
    ];
    if (opts.length === 0) {
      body.push(theme.fg("dim", "  No matches"));
    } else {
      const clamped = Math.min(Math.max(pickIndex, 0), opts.length - 1);
      pickIndex = clamped;
      let start = Math.max(0, clamped - Math.floor(maxVisible / 2));
      let end = Math.min(opts.length, start + maxVisible);
      start = Math.max(0, end - maxVisible);
      if (start > 0) body.push(theme.fg("dim", "  ↑ more"));
      for (let i = start; i < end; i++) {
        const selected = i === clamped;
        const pointer = selected ? theme.fg("accent", "› ") : "  ";
        const text = selected ? theme.fg("accent", opts[i]!) : opts[i]!;
        body.push(`${pointer}${text}`);
      }
      if (end < opts.length) body.push(theme.fg("dim", "  ↓ more"));
    }
    body.push("");
    body.push(theme.fg("dim", " Enter apply · Esc back"));
    return renderPanel(body, width, title);
  }

  return {
    invalidate() {},
    handleInput(data: string) {
      if (mode === "main") handleMainInput(data);
      else handlePickInput(data);
    },
    render(width: number) {
      return mode === "main" ? renderMain(width) : renderPicker(width);
    },
  };
}

function uniqueOptions(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

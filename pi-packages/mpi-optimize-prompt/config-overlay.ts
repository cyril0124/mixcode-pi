/**
 * Overlay UI for /opt-prompt config.
 * Main list: Model / Thinking / System prompt
 * Nested pickers for model + thinking; prompt edit closes overlay and uses ui.editor.
 * Changes apply immediately via onChange (host persists to disk).
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { OPTIMIZE_PROMPT_INHERIT, type OptimizePromptConfig } from "./core.js";

export type ConfigOverlayResult =
  | { action: "edit-prompt"; config: OptimizePromptConfig }
  | { action: "close" };

type ThemeLike = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
};

type Mode = "main" | "pick-model" | "pick-thinking";

type MainRow = "model" | "thinking" | "systemPrompt";

const MAIN_ROWS: MainRow[] = ["model", "thinking", "systemPrompt"];

export interface OptimizePromptConfigOverlayOptions {
  theme: ThemeLike;
  requestRender: () => void;
  done: (result: ConfigOverlayResult) => void;
  /** Called on every model/thinking change so the host can persist immediately. */
  onChange?: (config: OptimizePromptConfig) => void;
  initial: OptimizePromptConfig;
  modelOptions: string[];
  thinkingOptions: string[];
  /** Max list rows for pickers (excluding chrome). */
  getMaxVisible?: () => number;
}

export function createOptimizePromptConfigOverlay(options: OptimizePromptConfigOverlayOptions): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { theme, requestRender, done, onChange } = options;
  let draft: OptimizePromptConfig = { ...options.initial };
  let mode: Mode = "main";
  let mainIndex = 0;
  let pickIndex = 0;
  let pickQuery = "";

  const modelOptions = uniqueOptions([OPTIMIZE_PROMPT_INHERIT, ...options.modelOptions]);
  const thinkingOptions = uniqueOptions([OPTIMIZE_PROMPT_INHERIT, ...options.thinkingOptions]);

  function currentModelLabel(): string {
    return draft.model?.trim() || OPTIMIZE_PROMPT_INHERIT;
  }

  function currentThinkingLabel(): string {
    return draft.thinking?.trim() || OPTIMIZE_PROMPT_INHERIT;
  }

  function systemPromptPreview(width: number): string {
    const raw = draft.systemPrompt?.trim();
    if (!raw) return theme.fg("dim", "(built-in default)");
    const first = raw.split(/\r?\n/).find((line) => line.trim())?.trim() ?? raw;
    return truncateToWidth(first.replace(/\s+/g, " "), Math.max(8, width - 22));
  }

  function commit(next: OptimizePromptConfig): void {
    draft = next;
    onChange?.({ ...draft });
  }

  function setModel(value: string): void {
    if (!value || value === OPTIMIZE_PROMPT_INHERIT) {
      const { model: _drop, ...rest } = draft;
      commit(rest);
      return;
    }
    commit({ ...draft, model: value });
  }

  function setThinking(value: string): void {
    if (!value || value === OPTIMIZE_PROMPT_INHERIT) {
      const { thinking: _drop, ...rest } = draft;
      commit(rest);
      return;
    }
    commit({ ...draft, thinking: value });
  }

  function filteredPickOptions(): string[] {
    const all = mode === "pick-model" ? modelOptions : thinkingOptions;
    const q = pickQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter((item) => item.toLowerCase().includes(q));
  }

  function openPicker(next: "pick-model" | "pick-thinking"): void {
    mode = next;
    pickQuery = "";
    const optionsList = next === "pick-model" ? modelOptions : thinkingOptions;
    const current = next === "pick-model" ? currentModelLabel() : currentThinkingLabel();
    const idx = optionsList.indexOf(current);
    pickIndex = idx >= 0 ? idx : 0;
    requestRender();
  }

  function handleMainInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      done({ action: "close" });
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
    if (matchesKey(data, "e")) {
      done({ action: "edit-prompt", config: { ...draft } });
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const row = MAIN_ROWS[mainIndex];
      if (row === "model") openPicker("pick-model");
      else if (row === "thinking") openPicker("pick-thinking");
      else done({ action: "edit-prompt", config: { ...draft } });
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
        else setThinking(chosen);
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
    const innerWidth = Math.max(1, width - 2);
    const rows: Array<{ id: MainRow; label: string; value: string }> = [
      { id: "model", label: "Model", value: currentModelLabel() },
      { id: "thinking", label: "Thinking", value: currentThinkingLabel() },
      {
        id: "systemPrompt",
        label: "System prompt",
        value: systemPromptPreview(innerWidth),
      },
    ];

    const body: string[] = [
      theme.fg("dim", " Changes apply immediately · Enter edit · e prompt editor"),
      "",
    ];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const selected = i === mainIndex;
      const pointer = selected ? theme.fg("accent", "› ") : "  ";
      const label = selected ? theme.fg("accent", row.label.padEnd(14)) : row.label.padEnd(14);
      const value = selected ? theme.fg("accent", row.value) : theme.fg("dim", row.value);
      body.push(`${pointer}${label} ${value}`);
    }

    body.push("");
    body.push(theme.fg("dim", " Esc close · e open editor for system prompt"));
    return renderPanel(body, width, "Optimize Prompt Config");
  }

  function renderPicker(width: number): string[] {
    const title = mode === "pick-model" ? "Select model" : "Select thinking";
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

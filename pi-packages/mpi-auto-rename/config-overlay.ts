/**
 * Overlay UI for /auto-rename config — model picker only.
 * Enter applies immediately and closes; Esc closes without a further write.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AUTO_RENAME_INHERIT, type AutoRenameConfig } from "./config.js";

export type ConfigOverlayResult = { action: "close" };

type ThemeLike = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
};

export interface AutoRenameConfigOverlayOptions {
  theme: ThemeLike;
  requestRender: () => void;
  done: (result: ConfigOverlayResult) => void;
  /** Called when the user picks a model so the host can persist immediately. */
  onChange?: (config: AutoRenameConfig) => void;
  initial: AutoRenameConfig;
  modelOptions: string[];
  getMaxVisible?: () => number;
}

export function createAutoRenameConfigOverlay(options: AutoRenameConfigOverlayOptions): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { theme, requestRender, done, onChange } = options;
  let draft: AutoRenameConfig = { ...options.initial };
  let pickIndex = 0;
  let pickQuery = "";

  const modelOptions = uniqueOptions([AUTO_RENAME_INHERIT, ...options.modelOptions]);
  {
    const current = draft.model?.trim() || AUTO_RENAME_INHERIT;
    const idx = modelOptions.indexOf(current);
    pickIndex = idx >= 0 ? idx : 0;
  }

  function currentModelLabel(): string {
    return draft.model?.trim() || AUTO_RENAME_INHERIT;
  }

  function setModel(value: string): AutoRenameConfig {
    if (!value || value === AUTO_RENAME_INHERIT) {
      draft = {};
    } else {
      draft = { model: value };
    }
    onChange?.({ ...draft });
    return draft;
  }

  function filteredPickOptions(): string[] {
    const q = pickQuery.trim().toLowerCase();
    if (!q) return modelOptions;
    return modelOptions.filter((item) => item.toLowerCase().includes(q));
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

  function renderPicker(width: number): string[] {
    const opts = filteredPickOptions();
    const maxVisible = Math.max(3, options.getMaxVisible?.() ?? 10);
    const body: string[] = [
      theme.fg("dim", ` Filter: ${pickQuery.length > 0 ? pickQuery : "(type to filter)"} · current ${currentModelLabel()}`),
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
    body.push(theme.fg("dim", " Enter apply · Esc close"));
    return renderPanel(body, width, "Auto-rename model");
  }

  return {
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
        done({ action: "close" });
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
        if (chosen) setModel(chosen);
        done({ action: "close" });
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
    },
    render(width: number) {
      return renderPicker(width);
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

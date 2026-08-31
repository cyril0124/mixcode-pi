import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TranscriptConfig, TranscriptEditorMode } from "./config.js";

interface ThemeLike {
  fg(color: string, text: string): string;
}

export interface TranscriptConfigOverlayOptions {
  theme: ThemeLike;
  requestRender: () => void;
  done: () => void;
  configPath: string;
  initial: TranscriptConfig;
  options: TranscriptEditorMode[];
  persist: (
    config: TranscriptConfig,
  ) => { ok: true; config: TranscriptConfig } | { ok: false; error: string };
  onError: (message: string) => void;
}

const MODE_LABELS: Record<TranscriptEditorMode, string> = {
  auto: "Auto (nvim > vim > built-in)",
  nvim: "nvim",
  vim: "vim",
  builtin: "Built-in",
};

export function transcriptEditorModeLabel(mode: TranscriptEditorMode): string {
  return MODE_LABELS[mode];
}

export function createTranscriptConfigOverlay(options: TranscriptConfigOverlayOptions): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { theme, requestRender, done } = options;
  let draft = { ...options.initial };
  let selectedIndex = Math.max(0, options.options.indexOf(draft.editor));

  function selectedMode(): TranscriptEditorMode {
    return options.options[selectedIndex] ?? "auto";
  }

  function currentLabel(): string {
    if (options.options.includes(draft.editor)) return transcriptEditorModeLabel(draft.editor);
    return `${transcriptEditorModeLabel(draft.editor)} (unavailable)`;
  }

  function padLine(text: string, width: number): string {
    const singleLine = text.replace(/[\r\n]+/g, " ");
    const clipped =
      visibleWidth(singleLine) <= width ? singleLine : truncateToWidth(singleLine, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  function renderPanel(body: string[], width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    const title = " Transcript Editor ";
    const top = `${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}`;
    const border = (text: string) => theme.fg("border", text);
    return [
      `${border("┌")}${border(padLine(top, innerWidth))}${border("┐")}`,
      ...body.map((line) => `${border("│")}${padLine(line, innerWidth)}${border("│")}`),
      `${border("└")}${border("─".repeat(innerWidth))}${border("┘")}`,
    ];
  }

  function persistSelection(): void {
    const persisted = options.persist({ ...draft, editor: selectedMode() });
    if (!persisted.ok) {
      options.onError(persisted.error);
      requestRender();
      return;
    }
    draft = { ...persisted.config };
    requestRender();
  }

  return {
    invalidate() {},
    handleInput(data: string): void {
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
        done();
        return;
      }
      if (matchesKey(data, "up")) {
        selectedIndex = (selectedIndex - 1 + options.options.length) % options.options.length;
        requestRender();
        return;
      }
      if (matchesKey(data, "down")) {
        selectedIndex = (selectedIndex + 1) % options.options.length;
        requestRender();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
        persistSelection();
      }
    },
    render(width: number): string[] {
      const body = [
        theme.fg("dim", ` Current: ${currentLabel()}`),
        "",
        ...options.options.map((mode, index) => {
          const marker = index === selectedIndex ? theme.fg("accent", "› ") : "  ";
          const label =
            index === selectedIndex ? theme.fg("accent", MODE_LABELS[mode]) : MODE_LABELS[mode];
          return `${marker}${label}`;
        }),
        "",
        theme.fg("dim", ` ${options.configPath}`),
        theme.fg("dim", " ↑↓ select  Enter save  Esc close"),
      ];
      return renderPanel(body, width);
    },
  };
}

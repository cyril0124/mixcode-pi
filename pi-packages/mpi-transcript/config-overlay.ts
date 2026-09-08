import type { Component, Focusable } from "@earendil-works/pi-tui";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TranscriptConfig, TranscriptEditorMode } from "./config.js";
import { parseTranscriptConfig } from "./config.js";

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

interface TranscriptConfigOverlay extends Component, Focusable {
  handleInput(data: string): void;
}

export function createTranscriptConfigOverlay(
  options: TranscriptConfigOverlayOptions,
): TranscriptConfigOverlay {
  const { theme, requestRender, done } = options;
  let draft = { ...options.initial };
  let selectedIndex = Math.max(0, options.options.indexOf(draft.editor));
  const thresholdIndex = options.options.length;
  const itemCount = thresholdIndex + 1;
  const thresholdInput = new Input({ prompt: " Fold threshold: " });
  let editingThreshold = false;
  let focused = false;

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
    const title = " Transcript Settings ";
    const top = `${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}`;
    const border = (text: string) => theme.fg("border", text);
    return [
      `${border("┌")}${border(padLine(top, innerWidth))}${border("┐")}`,
      ...body.map((line) => `${border("│")}${padLine(line, innerWidth)}${border("│")}`),
      `${border("└")}${border("─".repeat(innerWidth))}${border("┘")}`,
    ];
  }

  function persistConfig(config: TranscriptConfig): boolean {
    const persisted = options.persist(config);
    if (!persisted.ok) {
      options.onError(`Error: ${persisted.error}`);
      requestRender();
      return false;
    }
    draft = { ...persisted.config };
    requestRender();
    return true;
  }

  function finishEditing(): void {
    editingThreshold = false;
    thresholdInput.focused = false;
    requestRender();
  }

  thresholdInput.onEscape = finishEditing;
  thresholdInput.onSubmit = (value) => {
    // Reject empty input before Number() can turn it into a valid zero.
    const foldThreshold = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    let config: TranscriptConfig;
    try {
      config = parseTranscriptConfig({
        editor: draft.editor,
        foldThreshold,
        $schema: draft.schemaRef,
      });
    } catch (error) {
      options.onError(`Error: ${error instanceof Error ? error.message : String(error)}`);
      requestRender();
      return;
    }
    if (persistConfig(config)) finishEditing();
  };

  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      thresholdInput.focused = value && editingThreshold;
    },
    invalidate() {
      thresholdInput.invalidate();
    },
    handleInput(data: string): void {
      // While editing, printable keys belong to Input; q must not close the panel.
      if (editingThreshold) {
        if (matchesKey(data, "ctrl+c")) finishEditing();
        else if (matchesKey(data, "ctrl+u")) thresholdInput.setValue("");
        else thresholdInput.handleInput(data);
        requestRender();
        return;
      }
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
        done();
        return;
      }
      if (matchesKey(data, "up")) {
        selectedIndex = (selectedIndex - 1 + itemCount) % itemCount;
        requestRender();
        return;
      }
      if (matchesKey(data, "down")) {
        selectedIndex = (selectedIndex + 1) % itemCount;
        requestRender();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
        if (selectedIndex === thresholdIndex) {
          thresholdInput.setValue(String(draft.foldThreshold));
          editingThreshold = true;
          thresholdInput.focused = focused;
          requestRender();
        } else {
          persistConfig({ ...draft, editor: selectedMode() });
        }
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
        ...(editingThreshold
          ? thresholdInput.render(Math.max(1, width - 2))
          : [
              selectedIndex === thresholdIndex
                ? theme.fg("accent", `› Fold threshold: ${draft.foldThreshold}`)
                : `  Fold threshold: ${draft.foldThreshold}`,
            ]),
        theme.fg("dim", " Fold tool bodies above this many lines (nvim/vim)."),
        "",
        theme.fg("dim", ` ${options.configPath}`),
        theme.fg(
          "dim",
          editingThreshold
            ? " Ctrl+U clear  Enter save  Esc cancel"
            : " ↑↓ select  Enter save/edit  Esc close",
        ),
      ];
      return renderPanel(body, width);
    },
  };
}

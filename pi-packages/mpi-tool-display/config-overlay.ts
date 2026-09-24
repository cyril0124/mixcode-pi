import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolDisplayRuntimeConfig } from "./config.js";

type ThemeLike = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
};

interface ToolDisplayConfigOverlayOptions {
  theme: ThemeLike;
  requestRender: () => void;
  done: () => void;
  configPath: string;
  initial: ToolDisplayRuntimeConfig;
  persist: (
    config: ToolDisplayRuntimeConfig,
  ) => { ok: true; config: ToolDisplayRuntimeConfig } | { ok: false; error: string };
  onError: (message: string) => void;
}

/** One toggle row; the label is what the panel shows, the key is what the config file holds. */
const CONFIG_ROWS = [
  { key: "compactBashCallRow", label: "Compact bash call row" },
  { key: "showRawToolArguments", label: "Raw tool arguments" },
] as const satisfies ReadonlyArray<{ key: keyof ToolDisplayRuntimeConfig; label: string }>;

export function createToolDisplayConfigOverlay(options: ToolDisplayConfigOverlayOptions): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { theme, requestRender, done } = options;
  let draft: ToolDisplayRuntimeConfig = { ...options.initial };
  let selectedIndex = 0;

  function toggleSelected(): void {
    const row = CONFIG_ROWS[selectedIndex]!;
    const next = { ...draft, [row.key]: !draft[row.key] };
    const persisted = options.persist(next);
    if (!persisted.ok) {
      options.onError(persisted.error);
      requestRender();
      return;
    }
    draft = { ...persisted.config };
    requestRender();
  }

  function moveSelection(step: number): void {
    const count = CONFIG_ROWS.length;
    selectedIndex = (selectedIndex + step + count) % count;
    requestRender();
  }

  function handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      done();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      moveSelection(1);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      toggleSelected();
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

  function renderRow(index: number): string {
    const row = CONFIG_ROWS[index]!;
    const selected = index === selectedIndex;
    const marker = selected ? theme.fg("accent", "› ") : "  ";
    const label = theme.fg("accent", row.label.padEnd(24));
    const value = draft[row.key] ? "on" : "off";
    return `${marker}${label} ${theme.fg("accent", value)}`;
  }

  function render(width: number): string[] {
    const selectedRow = CONFIG_ROWS[selectedIndex]!;
    const body = [
      theme.fg("dim", " Changes apply immediately · Enter toggle · j/k select"),
      "",
      ...CONFIG_ROWS.map((_row, index) => renderRow(index)),
      "",
      ...(selectedRow.key === "showRawToolArguments"
        ? [theme.fg("warning", " Debug only: arguments may expose secrets.")]
        : [theme.fg("dim", " One row per finished bash call, with label and status meta.")]),
      "",
      theme.fg("dim", ` ${options.configPath}`),
      theme.fg("dim", " Esc close"),
    ];
    return renderPanel(body, width, "Tool Display");
  }

  return {
    invalidate() {},
    handleInput,
    render,
  };
}

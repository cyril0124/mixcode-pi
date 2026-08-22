import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolDisplayRuntimeConfig } from "./config.js";

type ThemeLike = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
};

export interface ToolDisplayConfigOverlayOptions {
  theme: ThemeLike;
  requestRender: () => void;
  done: () => void;
  configPath: string;
  initial: ToolDisplayRuntimeConfig;
  persist: (
    config: ToolDisplayRuntimeConfig,
  ) =>
    | { ok: true; config: ToolDisplayRuntimeConfig }
    | { ok: false; error: string };
  onError: (message: string) => void;
}

export function createToolDisplayConfigOverlay(options: ToolDisplayConfigOverlayOptions): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { theme, requestRender, done } = options;
  let draft: ToolDisplayRuntimeConfig = { ...options.initial };

  function currentValueLabel(): string {
    return draft.showRawToolArguments ? "on" : "off";
  }

  function toggle(): void {
    const next = { showRawToolArguments: !draft.showRawToolArguments };
    const persisted = options.persist(next);
    if (!persisted.ok) {
      options.onError(persisted.error);
      requestRender();
      return;
    }
    draft = { ...persisted.config };
    requestRender();
  }

  function handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      done();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      toggle();
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

  function render(width: number): string[] {
    const label = "Raw tool arguments";
    const value = currentValueLabel();
    const body = [
      theme.fg("dim", " Changes apply immediately · Enter toggle"),
      theme.fg("warning", " Debug only: arguments may expose secrets."),
      "",
      `${theme.fg("accent", "› ")}${theme.fg("accent", label.padEnd(22))} ${theme.fg("accent", value)}`,
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

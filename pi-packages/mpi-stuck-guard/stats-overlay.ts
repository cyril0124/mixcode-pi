import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { StuckGuardStatsSnapshot } from "./stats.js";

export interface StuckGuardStatsOverlayOptions {
  tui: TUI;
  theme: { fg(color: string, text: string): string; bold(text: string): string };
  stats: () => StuckGuardStatsSnapshot;
  done: () => void;
}

function row(label: string, value: number): string {
  return `${label}: ${value}`;
}

/** Read-only Editor view for current-session provider watchdog counters. */
export function createStuckGuardStatsOverlay(options: StuckGuardStatsOverlayOptions) {
  return {
    handleInput(data: string): void {
      if (data === "q" || data === "\u001b" || data === "\u0003") options.done();
    },
    invalidate() {},
    render(width: number): string[] {
      const stats = options.stats();
      const inner = Math.max(20, width - 4);
      const lines = [
        options.theme.bold(options.theme.fg("accent", "Stuck Guard Stats")),
        options.theme.fg("dim", "Current session only"),
        "",
        options.theme.bold(options.theme.fg("accent", "Provider stream watchdog")),
        row("Provider attempts", stats.providerAttempts),
        row("Completed streams", stats.providerCompletions),
        row("Start timeouts", stats.providerStartTimeouts),
        row("Idle timeouts", stats.providerIdleTimeouts),
        row("Provider errors", stats.providerErrors),
        row("User aborts", stats.providerUserAborts),
        row("Retry cooldown events", stats.retryCooldowns),
        "",
        options.theme.fg("dim", "Esc/q close · /stuck-guard stats to reopen"),
      ];
      const border = (text: string) => options.theme.fg("accent", text);
      const container = new Container();
      container.addChild(new DynamicBorder(border));
      container.addChild(
        new Text(lines.map((line) => truncateToWidth(line, inner)).join("\n"), 1, 0),
      );
      container.addChild(new DynamicBorder(border));
      return container.render(width).map((line) => truncateToWidth(line, Math.max(1, width)));
    },
  };
}

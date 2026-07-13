/**
 * mpi-loop — Run a prompt on a recurring interval with TUI management
 *
 * Adapted from: https://github.com/emanuelcasco/pi-mono-extensions/blob/main/extensions/loop/index.ts
 * Adds: TUI widget (always-visible status below editor) + interactive overlay (keyboard nav + management)
 *
 * Usage:
 * /loop — open management overlay
 * /loop [interval] <prompt> — start a new loop
 * /loop stop <id|name> — stop a specific loop
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { LoopManagementView } from "./loop-management-view.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL = "10m";
const MIN_INTERVAL_MS = 10_000; // 10 seconds
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const USAGE_MESSAGE = `Usage: /loop [interval] <prompt>

Run a prompt on a recurring interval.

Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum is 10s.
If no interval is specified, defaults to ${DEFAULT_INTERVAL}.

Commands:
 /loop — open management overlay
 /loop [interval] <prompt> — start a new loop
 /loop stop <id|name> — stop a specific loop

Examples:
 /loop 5m /review
 /loop 30m check the deploy
 /loop 1h run the tests
 /loop check the deploy (defaults to ${DEFAULT_INTERVAL})
 /loop check the deploy every 20m`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoopEntry {
  id: string;
  name: string;
  prompt: string;
  intervalMs: number;
  intervalLabel: string;
  createdAt: Date;
  fireCount: number;
  nextRunAt: number;
  timer: ReturnType<typeof setInterval>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Interval parsing helpers
// ---------------------------------------------------------------------------

/** Parse a token like "5m", "2h", "30s", "1d" → milliseconds, or null. */
function parseIntervalToken(token: string): number | null {
  const m = token.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  switch (unit) {
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return null;
  }
}

/** Human-readable label for an interval in ms. */
function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

interface ParseResult {
  intervalMs: number;
  intervalLabel: string;
  prompt: string;
}

/**
 * Parse `[interval] <prompt>` using the same priority rules as the original skill:
 * 1. Leading token that matches \d+[smhd]
 * 2. Trailing "every <interval>" clause
 * 3. Default interval (DEFAULT_INTERVAL)
 */
function parseArgs(input: string): ParseResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Rule 1 — leading token
  const leading = trimmed.match(/^\S+/)?.[0] ?? "";
  const leadingMs = parseIntervalToken(leading);
  if (leadingMs !== null) {
    const prompt = trimmed.slice(leading.length).trim();
    return { intervalMs: leadingMs, intervalLabel: leading.toLowerCase(), prompt };
  }

  // Rule 2 — trailing "every <interval>" or "every <number> <unit>"
  const trailingExact = trimmed.match(
    /^([\s\S]+?)\s+every\s+(\d+(?:\.\d+)?)(s|m|h|d|seconds?|minutes?|hours?|days?)$/i,
  );
  if (trailingExact) {
    const rawUnit = trailingExact[3]!.toLowerCase();
    const canonicalUnit = rawUnit.startsWith("s")
      ? "s"
      : rawUnit.startsWith("m")
        ? "m"
        : rawUnit.startsWith("h")
          ? "h"
          : "d";
    const token = `${trailingExact[2]}${canonicalUnit}`;
    const ms = parseIntervalToken(token)!;
    const prompt = trailingExact[1]!.trim();
    return { intervalMs: ms, intervalLabel: token, prompt };
  }

  // Rule 3 — default
  const defaultMs = parseIntervalToken(DEFAULT_INTERVAL)!;
  return { intervalMs: defaultMs, intervalLabel: DEFAULT_INTERVAL, prompt: trimmed };
}

// ---------------------------------------------------------------------------
// Relative time formatting
// ---------------------------------------------------------------------------

function formatRelativeTime(date: Date | number): string {
  const now = Date.now();
  const target = typeof date === "number" ? date : date.getTime();
  const diff = target - now;
  const absDiff = Math.abs(diff);

  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let timeStr: string;
  if (days > 0) {
    timeStr = `${days}d`;
  } else if (hours > 0) {
    timeStr = `${hours}h`;
  } else if (minutes > 0) {
    timeStr = `${minutes}m`;
  } else {
    timeStr = `${seconds}s`;
  }

  return diff > 0 ? `in ${timeStr}` : `${timeStr} ago`;
}

// ---------------------------------------------------------------------------
// Loop registry (in-memory, process-scoped)
// ---------------------------------------------------------------------------

const activeLoops = new Map<string, LoopEntry>();
let nextLoopId = 1;

function generateId(): string {
  return String(nextLoopId++);
}

function generateName(prompt: string): string {
  // Extract first meaningful word from prompt
  const words = prompt.trim().split(/\s+/);
  const first = words[0] || "loop";
  // Remove slash prefix if it's a command
  const clean = first.startsWith("/") ? first.slice(1) : first;
  return clean.substring(0, 15);
}

function cancelLoop(entry: LoopEntry): void {
  clearInterval(entry.timer);
  clearTimeout(entry.expiryTimer);
  activeLoops.delete(entry.id);
}

function cancelAllLoops(): number {
  const count = activeLoops.size;
  for (const entry of activeLoops.values()) {
    cancelLoop(entry);
  }
  return count;
}

function findLoop(idOrName: string): LoopEntry | undefined {
  // Try ID first
  const byId = activeLoops.get(idOrName);
  if (byId) return byId;

  // Try name match
  for (const entry of activeLoops.values()) {
    if (entry.name === idOrName) return entry;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// TUI Widget (always visible below editor)
// ---------------------------------------------------------------------------

const WIDGET_ID = "loop-widget";

class LoopWidget {
  private refreshInterval?: NodeJS.Timeout;
  private ctx?: any;
  private unsubscribe?: () => void;

  constructor(
    private pi: ExtensionAPI,
  ) {}

  show(ctx: any): void {
    this.ctx = ctx;

    if (activeLoops.size === 0) {
      this.hide(ctx);
      return;
    }

    ctx.ui.setWidget(
      WIDGET_ID,
      (_tui: any, theme: any) => ({
        render: (width: number) => this.renderWidget(width, theme),
        invalidate: () => {},
      }),
      { placement: "belowEditor" },
    );

    if (!this.refreshInterval) {
      this.refreshInterval = setInterval(() => this.refresh(), 30000);
    }

    // Listen for loop changes
    if (!this.unsubscribe) {
      this.unsubscribe = this.pi.events.on("loop:change", () => this.refresh());
    }
  }

  hide(ctx: any): void {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  private refresh(): void {
    if (this.ctx) this.show(this.ctx);
  }

  private renderWidget(width: number, theme: any): string[] {
    const loops = Array.from(activeLoops.values());
    const container = new Container();
    const borderColor = (s: string) => theme.fg("accent", s);

    container.addChild(new DynamicBorder(borderColor));
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold("Active Loops")) + theme.fg("dim", ` (${loops.length})`),
        1,
        0,
      ),
    );
    container.addChild(new Spacer(1));

    const fitCell = (value: string, cellWidth: number): string => {
      const clipped = truncateToWidth(value.replace(/[\r\n]+/g, " "), cellWidth, "...");
      return clipped + " ".repeat(Math.max(0, cellWidth - visibleWidth(clipped)));
    };
    const tableWidth = Math.max(52, width - 6);
    const flexibleWidth = Math.max(20, tableWidth - 32);
    const nameWidth = Math.min(15, Math.max(8, Math.floor(flexibleWidth / 3)));
    const promptWidth = Math.min(28, Math.max(12, flexibleWidth - nameWidth));
    const header = ` ${fitCell("ON", 2)} ${fitCell("ID", 3)} ${fitCell("NAME", nameWidth)} ${fitCell("INTERVAL", 8)} ${fitCell("PROMPT", promptWidth)} ${fitCell("NEXT", 8)} ${fitCell("RUNS", 4)}`;
    const lines: string[] = [theme.fg("dim", header)];
    for (const loop of loops) {
      const statusIcon = theme.fg("success", fitCell("✓", 2));
      const idText = theme.fg("accent", fitCell(loop.id, 3));
      const nameText = theme.fg("text", fitCell(loop.name, nameWidth));
      const intervalText = theme.fg("dim", fitCell(loop.intervalLabel, 8));
      const promptText = theme.fg("dim", fitCell(loop.prompt, promptWidth));
      const nextText = fitCell(formatRelativeTime(loop.nextRunAt), 8);
      const countText = theme.fg("accent", fitCell(String(loop.fireCount), 4));

      lines.push(
        ` ${statusIcon} ${idText} ${nameText} ${intervalText} ${promptText} ${nextText} ${countText}`,
      );
    }

    container.addChild(new Text(lines.join("\n"), 1, 0));
    container.addChild(new DynamicBorder(borderColor));

    return container.render(width);
  }

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }
}

// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let widget: LoopWidget | undefined;

  pi.on("session_start", async (_event, ctx) => {
    widget = new LoopWidget(pi);
    if (activeLoops.size > 0) {
      widget.show(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    cancelAllLoops();
    if (widget) {
      widget.destroy();
      widget = undefined;
    }
  });

  pi.registerCommand("loop", {
    description: `Run a prompt on a recurring interval. Usage: /loop [interval] <prompt> (default: ${DEFAULT_INTERVAL})`,
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim();

      // If empty or only whitespace, show subcommands
      if (!trimmed) {
        return [
          { label: "stop <id|name>", description: "Stop a running loop", value: "stop " },
          { label: "30s <prompt>", description: "Run prompt every 30 seconds", value: "30s " },
          { label: "1m <prompt>", description: "Run prompt every 1 minute", value: "1m " },
          { label: "5m <prompt>", description: "Run prompt every 5 minutes", value: "5m " },
        ];
      }

      // If starts with "stop", show loop IDs
      if (trimmed.startsWith("stop")) {
        const loops = Array.from(activeLoops.values());
        if (loops.length === 0) return null;
        return loops.map(loop => ({
          label: `${loop.id} (${loop.name})`,
          description: `Stop "${loop.prompt}"`,
          value: `stop ${loop.id}`,
        }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const firePrompt = (prompt: string) => {
        if (ctx.isIdle()) pi.sendUserMessage(prompt);
        else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      };

      // ── No args: open management overlay ──────────────────────────
      if (!trimmed || trimmed === "help") {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) =>
            new LoopManagementView(
              theme,
              () => tui.requestRender(),
              () => done(undefined),
              () => Math.floor(tui.terminal.rows * 0.8) - 6,
              {
                getLoops: () => Array.from(activeLoops.values()),
                fire: firePrompt,
                remove: (id) => {
                  const entry = activeLoops.get(id);
                  if (entry) cancelLoop(entry);
                  pi.events.emit("loop:change", {});
                },
                clear: () => {
                  cancelAllLoops();
                  pi.events.emit("loop:change", {});
                },
              },
            ),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "78%",
              maxHeight: "80%",
              margin: 1,
            },
          },
        );
        return;
      }

      // ── Stop subcommand ─────────────────────────────────────────────
      if (trimmed.startsWith("stop ")) {
        const idOrName = trimmed.slice(5).trim();
        const entry = findLoop(idOrName);
        if (!entry) {
          ctx.ui.notify(
            `No loop found with ID or name "${idOrName}". Use /loop to see active loops.`,
            "warning",
          );
          return;
        }
        cancelLoop(entry);
        ctx.ui.notify(`Loop "${entry.name}" (ID: ${entry.id}) stopped.`, "info");
        pi.events.emit("loop:change", {});
        if (widget) widget.show(ctx);
        return;
      }

      if (trimmed === "stop") {
        ctx.ui.notify(USAGE_MESSAGE, "warning");
        return;
      }

      // ── Schedule ─────────────────────────────────────────────────────
      const parsed = parseArgs(trimmed);
      if (!parsed?.prompt) {
        ctx.ui.notify(USAGE_MESSAGE, "warning");
        return;
      }

      const { prompt, intervalMs, intervalLabel } = parsed;

      if (intervalMs < MIN_INTERVAL_MS) {
        ctx.ui.notify(
          `Interval "${intervalLabel}" is below the minimum (${formatInterval(MIN_INTERVAL_MS)}). Using ${formatInterval(MIN_INTERVAL_MS)} instead.`,
          "warning",
        );
      }
      const effectiveMs = Math.max(intervalMs, MIN_INTERVAL_MS);

      const id = generateId();
      const name = generateName(prompt);

      const sendPrompt = () => {
        const entry = activeLoops.get(id);
        if (entry) {
          entry.fireCount++;
          entry.nextRunAt = Date.now() + entry.intervalMs;
          pi.events.emit("loop:change", {});
        }
        firePrompt(prompt);
      };

      const timer = setInterval(sendPrompt, effectiveMs);

      const expiryTimer = setTimeout(() => {
        const entry = activeLoops.get(id);
        if (entry) {
          cancelLoop(entry);
          ctx.ui.notify(
            `Loop "${entry.name}" (ID: ${id}) auto-expired after ${formatInterval(MAX_AGE_MS)}.`,
            "info",
          );
          pi.events.emit("loop:change", {});
          if (widget) widget.show(ctx);
        }
      }, MAX_AGE_MS);

      const entry: LoopEntry = {
        id,
        name,
        prompt,
        intervalMs: effectiveMs,
        intervalLabel: formatInterval(effectiveMs),
        createdAt: new Date(),
        fireCount: 0,
        nextRunAt: Date.now() + effectiveMs,
        timer,
        expiryTimer,
      };
      activeLoops.set(id, entry);

      ctx.ui.notify(
        `Loop scheduled!\n` +
          ` ID: ${id}\n` +
          ` Name: ${name}\n` +
          ` Prompt: "${prompt}"\n` +
          ` Interval: every ${formatInterval(effectiveMs)}\n` +
          ` Auto-expires: after ${formatInterval(MAX_AGE_MS)}\n` +
          ` Stop with: /loop stop ${id}`,
        "info",
      );

      pi.events.emit("loop:change", {});
      if (widget) widget.show(ctx);

      // Run the prompt immediately on first invocation
      firePrompt(prompt);
    },
  });
}

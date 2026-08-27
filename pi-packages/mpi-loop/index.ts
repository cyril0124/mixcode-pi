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
 * /loop interval <id|name> <interval> — reschedule an existing loop
 * /loop prompt <id|name> <prompt> — rewrite an existing loop prompt
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_INTERVAL,
  MAX_AGE_MS,
  MIN_INTERVAL_MS,
  formatInterval,
  formatRelativeTime,
  generateName,
  isStaleCtxError,
  parseArgs,
  parseIntervalToken,
} from "./loop-helpers.js";
import { LoopManagementView } from "./loop-management-view.js";

const USAGE_MESSAGE = `Usage: /loop [interval] <prompt>

Run a prompt on a recurring interval.

Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum is 10s.
If no interval is specified, defaults to ${DEFAULT_INTERVAL}.

Commands:
 /loop — open management overlay
 /loop [interval] <prompt> — start a new loop
 /loop stop <id|name> — stop a specific loop
 /loop interval <id|name> <interval> — reschedule an existing loop
 /loop prompt <id|name> <prompt> — rewrite an existing loop prompt

Examples:
 /loop 5m /review
 /loop 30m check the deploy
 /loop 1h run the tests
 /loop check the deploy (defaults to ${DEFAULT_INTERVAL})
 /loop check the deploy every 20m
 /loop interval 1 30s
 /loop prompt 1 check deploy status`;

type LoopConflictMode = "skip" | "defer";

interface LoopEntry {
  id: string;
  name: string;
  prompt: string;
  intervalMs: number;
  intervalLabel: string;
  fireCount: number;
  maxFireCount: number | null;
  nextRunAt: number;
  /** Timer-tick conflict policy. Manual fire / first immediate fire ignore this. */
  mode: LoopConflictMode;
  /** defer: at most one coalesced fire waiting for agent idle. */
  pending: boolean;
  timer: ReturnType<typeof setInterval>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// TUI Widget (always visible below editor)
// ---------------------------------------------------------------------------

const WIDGET_ID = "loop-widget";

class LoopWidget {
  private refreshInterval?: NodeJS.Timeout;
  private ctx?: ExtensionContext;
  private unsubscribe?: () => void;

  constructor(
    private pi: ExtensionAPI,
    /** Loops for THIS tab/extension instance only (factory-scoped map). */
    private listLoops: () => LoopEntry[],
  ) {}

  show(ctx: ExtensionContext): void {
    this.ctx = ctx;

    try {
      if (this.listLoops().length === 0) {
        this.hide(ctx);
        return;
      }

      ctx.ui.setWidget(
        WIDGET_ID,
        (_tui: TUI, theme: Theme) => ({
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
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
      // Captured ctx died (session replace/reload) — stop async refresh paths.
      this.destroy();
    }
  }

  hide(ctx?: ExtensionContext): void {
    const target = ctx ?? this.ctx;
    if (target) {
      try {
        target.ui.setWidget(WIDGET_ID, undefined);
      } catch (e) {
        if (!isStaleCtxError(e)) throw e;
      }
    }
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  private refresh(): void {
    if (this.ctx) this.show(this.ctx);
  }

  private renderWidget(width: number, theme: Theme): string[] {
    const loops = this.listLoops();
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
    const tableWidth = Math.max(57, width - 6);
    const flexibleWidth = Math.max(20, tableWidth - 37);
    const nameWidth = Math.min(15, Math.max(8, Math.floor(flexibleWidth / 3)));
    const promptWidth = Math.min(28, Math.max(12, flexibleWidth - nameWidth));
    const header = ` ${fitCell("ON", 2)} ${fitCell("ID", 3)} ${fitCell("M", 1)} ${fitCell("NAME", nameWidth)} ${fitCell("INTERVAL", 8)} ${fitCell("PROMPT", promptWidth)} ${fitCell("NEXT", 8)} ${fitCell("RUNS", 9)}`;
    const lines: string[] = [theme.fg("dim", header)];
    for (const loop of loops) {
      const statusIcon = theme.fg("success", fitCell("✓", 2));
      const idText = theme.fg("accent", fitCell(loop.id, 3));
      const modeText = theme.fg("dim", fitCell(loop.mode === "defer" ? "D" : "S", 1));
      const nameText = theme.fg("text", fitCell(loop.name, nameWidth));
      const intervalText = theme.fg("dim", fitCell(loop.intervalLabel, 8));
      const promptText = theme.fg("dim", fitCell(loop.prompt, promptWidth));
      const nextLabel = loop.pending ? "waiting" : formatRelativeTime(loop.nextRunAt);
      const nextText = fitCell(nextLabel, 8);
      const fireCount =
        loop.maxFireCount === null
          ? String(loop.fireCount)
          : `${loop.fireCount}/${loop.maxFireCount}`;
      const countText = theme.fg("accent", fitCell(fireCount, 9));

      lines.push(
        ` ${statusIcon} ${idText} ${modeText} ${nameText} ${intervalText} ${promptText} ${nextText} ${countText}`,
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
    this.hide();
    this.ctx = undefined;
  }
}

// Extension
// ---------------------------------------------------------------------------
// Loop state is factory-scoped so each MixCode tab (each ExtensionRunner load)
// gets an isolated pool. A module-level Map would leak loops across tabs.

export default function (pi: ExtensionAPI) {
  const activeLoops = new Map<string, LoopEntry>();
  let nextLoopId = 1;
  let widget: LoopWidget | undefined;

  const listLoops = () => Array.from(activeLoops.values());

  const generateId = () => String(nextLoopId++);

  const cancelLoop = (entry: LoopEntry): void => {
    clearInterval(entry.timer);
    clearTimeout(entry.expiryTimer);
    activeLoops.delete(entry.id);
  };

  /** Replace the recurring timer only — prompt/mode/expiry/pending stay put. */
  const rescheduleLoop = (entry: LoopEntry, intervalMs: number, onTimerTick: () => void): void => {
    clearInterval(entry.timer);
    entry.intervalMs = intervalMs;
    entry.intervalLabel = formatInterval(intervalMs);
    entry.nextRunAt = Date.now() + intervalMs;
    entry.timer = setInterval(onTimerTick, intervalMs);
  };

  const cancelAllLoops = (): number => {
    const count = activeLoops.size;
    for (const entry of activeLoops.values()) {
      cancelLoop(entry);
    }
    return count;
  };

  const findLoop = (idOrName: string): LoopEntry | undefined => {
    const byId = activeLoops.get(idOrName);
    if (byId) return byId;
    for (const entry of activeLoops.values()) {
      if (entry.name === idOrName) return entry;
    }
    return undefined;
  };

  // A loop prompt is scheduled user input, so it expands like typed input:
  // `/cmd` dispatches, `/skill:x` and prompt templates expand. Without
  // expandPromptTemplates (pi defaults it to false) they reach the model as literal text.
  const deliverPrompt = (prompt: string, idle: boolean): boolean => {
    try {
      if (idle) pi.sendUserMessage(prompt, { expandPromptTemplates: true });
      else pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
      return true;
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
      return false;
    }
  };

  const commitFire = (entry: LoopEntry, idle: boolean) => {
    entry.pending = false;
    entry.fireCount++;
    entry.nextRunAt = Date.now() + entry.intervalMs;
    const reachedLimit = entry.maxFireCount !== null && entry.fireCount >= entry.maxFireCount;
    if (reachedLimit) cancelLoop(entry);
    pi.events.emit("loop:change", {});
    if (!deliverPrompt(entry.prompt, idle)) {
      // Runtime/pi for this extension instance is dead — drop all local loops.
      cancelAllLoops();
      widget?.destroy();
      widget = undefined;
    }
  };

  /** Flush coalesced defer ticks once the agent is actually idle. */
  const flushPending = (ctx: { isIdle: () => boolean }) => {
    try {
      if (!ctx.isIdle()) return;
      for (const entry of activeLoops.values()) {
        if (!entry.pending) continue;
        commitFire(entry, ctx.isIdle());
      }
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Replace widget without leaking the previous interval/subscription.
    widget?.destroy();
    widget = new LoopWidget(pi, listLoops);
    if (activeLoops.size > 0) {
      widget.show(ctx);
    }
  });

  // agent_end fires while isIdle is still false; only agent_settled is truly idle.
  pi.on("agent_settled", (_event, ctx) => {
    flushPending(ctx);
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
          {
            label: "interval <id|name> <interval>",
            description: "Reschedule a running loop",
            value: "interval ",
          },
          {
            label: "prompt <id|name> <prompt>",
            description: "Rewrite a running loop prompt",
            value: "prompt ",
          },
          { label: "30s <prompt>", description: "Run prompt every 30 seconds", value: "30s " },
          { label: "1m <prompt>", description: "Run prompt every 1 minute", value: "1m " },
          { label: "5m <prompt>", description: "Run prompt every 5 minutes", value: "5m " },
        ];
      }

      // If starts with "stop", show loop IDs
      if (trimmed.startsWith("stop")) {
        const loops = Array.from(activeLoops.values());
        if (loops.length === 0) return null;
        return loops.map((loop) => ({
          label: `${loop.id} (${loop.name})`,
          description: `Stop "${loop.prompt}"`,
          value: `stop ${loop.id}`,
        }));
      }

      // "interval" / "interval <id>" → loop ids; after id, suggest interval tokens
      if (trimmed === "interval" || trimmed.startsWith("interval ")) {
        const rest = trimmed.slice("interval".length).trim();
        const loops = Array.from(activeLoops.values());
        if (!rest) {
          if (loops.length === 0) return null;
          return loops.map((loop) => ({
            label: `${loop.id} (${loop.name})`,
            description: `Current: ${loop.intervalLabel}`,
            value: `interval ${loop.id} `,
          }));
        }
        const parts = rest.split(/\s+/);
        // After id is chosen, do not force interval presets — free-type Ns/Nm/Nh/Nd.
        if (parts.length >= 2) return null;
        const q = parts[0]!.toLowerCase();
        const matched = loops.filter(
          (loop) => loop.id.startsWith(q) || loop.name.toLowerCase().startsWith(q),
        );
        if (matched.length === 0) return null;
        return matched.map((loop) => ({
          label: `${loop.id} (${loop.name})`,
          description: `Current: ${loop.intervalLabel}`,
          value: `interval ${loop.id} `,
        }));
      }

      // "prompt" / "prompt <id>" → loop ids; after id, free-type new prompt text.
      if (trimmed === "prompt" || trimmed.startsWith("prompt ")) {
        const rest = trimmed.slice("prompt".length).trim();
        const loops = Array.from(activeLoops.values());
        if (!rest) {
          if (loops.length === 0) return null;
          return loops.map((loop) => ({
            label: `${loop.id} (${loop.name})`,
            description: `Current: ${loop.prompt}`,
            value: `prompt ${loop.id} `,
          }));
        }
        const parts = rest.split(/\s+/);
        if (parts.length >= 2) return null;
        const q = parts[0]!.toLowerCase();
        const matched = loops.filter(
          (loop) => loop.id.startsWith(q) || loop.name.toLowerCase().startsWith(q),
        );
        if (matched.length === 0) return null;
        return matched.map((loop) => ({
          label: `${loop.id} (${loop.name})`,
          description: `Current: ${loop.prompt}`,
          value: `prompt ${loop.id} `,
        }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const firePrompt = (prompt: string) => {
        deliverPrompt(prompt, ctx.isIdle());
      };
      // Command ctx is captured at schedule/reschedule time — dies on session replacement.
      const makeOnTimerTick = (loopId: string) => () => {
        const entry = activeLoops.get(loopId);
        if (!entry) return;
        try {
          if (ctx.isIdle()) {
            commitFire(entry, true);
            return;
          }
          if (entry.mode === "skip") {
            entry.nextRunAt = Date.now() + entry.intervalMs;
            pi.events.emit("loop:change", {});
            return;
          }
          entry.pending = true;
          pi.events.emit("loop:change", {});
        } catch (e) {
          if (!isStaleCtxError(e)) throw e;
          cancelLoop(entry);
          pi.events.emit("loop:change", {});
        }
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
                getLoops: listLoops,
                fire: firePrompt,
                setMode: (id, mode) => {
                  const entry = activeLoops.get(id);
                  if (!entry) return;
                  entry.mode = mode;
                  if (mode === "skip") entry.pending = false;
                  pi.events.emit("loop:change", {});
                },
                setMaxFireCount: (id, maxFireCount) => {
                  const entry = activeLoops.get(id);
                  if (!entry) return;
                  entry.maxFireCount = maxFireCount;
                  if (maxFireCount !== null && entry.fireCount >= maxFireCount) {
                    cancelLoop(entry);
                  }
                  pi.events.emit("loop:change", {});
                },
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

      // ── Interval (reschedule) subcommand ─────────────────────────────
      if (trimmed === "interval" || trimmed.startsWith("interval ")) {
        const rest = trimmed.slice("interval".length).trim();
        const parts = rest.split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          ctx.ui.notify(USAGE_MESSAGE, "warning");
          return;
        }
        const idOrName = parts[0]!;
        const intervalToken = parts[1]!;
        const entry = findLoop(idOrName);
        if (!entry) {
          ctx.ui.notify(
            `No loop found with ID or name "${idOrName}". Use /loop to see active loops.`,
            "warning",
          );
          return;
        }
        const intervalMs = parseIntervalToken(intervalToken);
        if (intervalMs === null) {
          ctx.ui.notify(
            `Invalid interval "${intervalToken}". Use Ns/Nm/Nh/Nd (e.g. 30s, 5m).`,
            "warning",
          );
          return;
        }
        if (intervalMs < MIN_INTERVAL_MS) {
          ctx.ui.notify(
            `Interval "${intervalToken}" is below the minimum (${formatInterval(MIN_INTERVAL_MS)}). Using ${formatInterval(MIN_INTERVAL_MS)} instead.`,
            "warning",
          );
        }
        const effectiveMs = Math.max(intervalMs, MIN_INTERVAL_MS);
        rescheduleLoop(entry, effectiveMs, makeOnTimerTick(entry.id));
        ctx.ui.notify(
          `Loop "${entry.name}" (ID: ${entry.id}) rescheduled to every ${formatInterval(effectiveMs)}.`,
          "info",
        );
        pi.events.emit("loop:change", {});
        if (widget) widget.show(ctx);
        return;
      }

      // ── Prompt rewrite subcommand ────────────────────────────────────
      if (trimmed === "prompt" || trimmed.startsWith("prompt ")) {
        const rest = trimmed.slice("prompt".length).trim();
        // Keep remainder intact so multiline prompts survive (do not split on whitespace).
        const space = rest.search(/\s/);
        const idOrName = space === -1 ? rest : rest.slice(0, space);
        const newPrompt = space === -1 ? "" : rest.slice(space + 1).trim();
        if (!idOrName || !newPrompt) {
          ctx.ui.notify(USAGE_MESSAGE, "warning");
          return;
        }
        const entry = findLoop(idOrName);
        if (!entry) {
          ctx.ui.notify(
            `No loop found with ID or name "${idOrName}". Use /loop to see active loops.`,
            "warning",
          );
          return;
        }
        entry.prompt = newPrompt;
        ctx.ui.notify(
          `Loop "${entry.name}" (ID: ${entry.id}) prompt updated to "${newPrompt}".`,
          "info",
        );
        pi.events.emit("loop:change", {});
        if (widget) widget.show(ctx);
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

      // Timer ticks only: skip or coalesce-defer while busy. First/manual fire bypass this.
      const onTimerTick = makeOnTimerTick(id);
      const timer = setInterval(onTimerTick, effectiveMs);

      const expiryTimer = setTimeout(() => {
        const entry = activeLoops.get(id);
        if (!entry) return;
        cancelLoop(entry);
        try {
          ctx.ui.notify(
            `Loop "${entry.name}" (ID: ${id}) auto-expired after ${formatInterval(MAX_AGE_MS)}.`,
            "info",
          );
          pi.events.emit("loop:change", {});
          if (widget) widget.show(ctx);
        } catch (e) {
          if (!isStaleCtxError(e)) throw e;
          pi.events.emit("loop:change", {});
        }
      }, MAX_AGE_MS);

      const entry: LoopEntry = {
        id,
        name,
        prompt,
        intervalMs: effectiveMs,
        intervalLabel: formatInterval(effectiveMs),
        fireCount: 0,
        maxFireCount: null,
        nextRunAt: Date.now() + effectiveMs,
        mode: "defer",
        pending: false,
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
          ` Conflict: defer (toggle in /loop detail with m)\n` +
          ` Auto-expires: after ${formatInterval(MAX_AGE_MS)}\n` +
          ` Stop with: /loop stop ${id}`,
        "info",
      );

      pi.events.emit("loop:change", {});
      if (widget) widget.show(ctx);

      // Immediate first run always delivers (not subject to skip/defer).
      commitFire(entry, ctx.isIdle());
    },
  });
}

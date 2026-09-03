import * as path from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createStuckGuardConfigOverlay } from "./config-overlay.js";
import { createStuckGuardStatsOverlay } from "./stats-overlay.js";
import { createProviderPicker } from "./provider-picker.js";
import {
  loadStuckGuardConfig,
  parseStuckGuardConfig,
  writeStuckGuardConfig,
  type StuckGuardConfig,
} from "./config.js";
import type { StuckGuardStats } from "./stats.js";

async function openConfigOverlay(
  ctx: ExtensionCommandContext,
  initial: StuckGuardConfig,
  agentDir: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Error: stuck-guard configuration requires the interactive UI", "error");
    return;
  }
  const providers = [
    ...new Set([
      ...ctx.modelRegistry.getAvailable().map((model) => model.provider),
      ...initial.providerIds,
    ]),
  ].sort();
  await ctx.ui.custom(
    (tui, theme, _keybindings, done) =>
      createStuckGuardConfigOverlay({
        tui,
        theme,
        initial,
        configPath: path.join(agentDir, "mpi-stuck-guard.json"),
        input: async (key, current) => {
          if (key !== "providerIds") return ctx.ui.input(`Set ${key}`, JSON.stringify(current));
          const deferred = Promise.withResolvers<string | undefined>();
          await ctx.ui.custom(
            (tui, theme, _keybindings, pickerDone) =>
              createProviderPicker({
                tui,
                theme,
                providers,
                selected: Array.isArray(current)
                  ? current.filter((value): value is string => typeof value === "string")
                  : [],
                done: (next) => {
                  deferred.resolve(JSON.stringify(next));
                  pickerDone(undefined);
                },
              }),
            { overlay: false },
          );
          return deferred.promise;
        },
        persist: (next) => {
          const checked = parseStuckGuardConfig(next);
          if (!checked.ok) return { ok: false as const, error: `Error: ${checked.error}` };
          const written = writeStuckGuardConfig(agentDir, checked.config);
          if (!written.ok) return { ok: false as const, error: `Error: ${written.error}` };
          return { ok: true as const };
        },
        onError: (message) => ctx.ui.notify(message, "error"),
        done: () => done(undefined),
      }),
    { overlay: false },
  );
}

async function openStatsOverlay(
  ctx: ExtensionCommandContext,
  stats: StuckGuardStats,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Error: stuck-guard stats requires the interactive UI", "error");
    return;
  }
  await ctx.ui.custom(
    (tui, theme, _keybindings, done) =>
      createStuckGuardStatsOverlay({
        tui,
        theme,
        stats: () => stats.snapshot(),
        done: () => done(undefined),
      }),
    { overlay: false },
  );
}

export function registerStuckGuardCommand(pi: ExtensionAPI, stats: StuckGuardStats): void {
  pi.registerCommand("stuck-guard", {
    description: "Open stuck-guard configuration or stats",
    ...({ argumentHint: "[config|stats]" } as Record<string, unknown>),
    getArgumentCompletions: (prefix: string) => {
      if (prefix.trim() === "") {
        return [
          { label: "config", description: "Open the configuration overlay", value: "config" },
          { label: "stats", description: "Open the watchdog statistics overlay", value: "stats" },
        ];
      }
      return null;
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim();
      if (subcommand !== "" && subcommand !== "config" && subcommand !== "stats") {
        ctx.ui.notify("Error: Usage: /stuck-guard [config|stats]", "error");
        return;
      }
      try {
        if (subcommand === "stats") {
          await openStatsOverlay(ctx, stats);
          return;
        }
        const loaded = loadStuckGuardConfig(getAgentDir());
        if (!loaded.ok) {
          ctx.ui.notify(`Error: ${loaded.error}`, "error");
          return;
        }
        await openConfigOverlay(ctx, loaded.config, getAgentDir());
      } catch (error) {
        ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

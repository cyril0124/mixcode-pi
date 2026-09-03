import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import {
  DEFAULT_STUCK_GUARD_CONFIG,
  loadStuckGuardConfig,
  type StuckGuardConfig,
  type StuckGuardConfigLoad,
} from "./config.js";
import { registerStuckGuardCommand } from "./config-command.js";
import { ProviderCooldownStore } from "./provider-watchdog.js";
import {
  wrapProvider,
  isWatchdogWrappedProvider,
  type ProviderWrapperOptions,
} from "./provider-wrapper.js";
import { StuckGuardStats } from "./stats.js";

function wrapperOptionsFrom(
  config: StuckGuardConfig,
  cooldowns: ProviderCooldownStore,
  stats: StuckGuardStats,
): ProviderWrapperOptions {
  return {
    enabled: config.streamWatchdogEnabled,
    streamStartTimeoutMs: config.streamStartTimeoutSeconds * 1000,
    streamIdleTimeoutMs: config.streamIdleTimeoutSeconds * 1000,
    streamRetryStartTimeoutMs: config.streamRetryStartTimeoutSeconds * 1000,
    knownTimeoutCooldownMs: config.knownTimeoutCooldownSeconds * 1000,
    cooldowns,
    onStateChange: (_providerId, _modelId, state) => {
      if (
        state === "idle" ||
        state === "completed" ||
        state === "provider_error" ||
        state === "user_aborted"
      ) {
        stats.recordProviderState(state);
      }
    },
    onTimeout: (_providerId, _modelId, kind) => stats.recordProviderTimeout(kind),
  };
}

/** Wire provider stream watchdogs and the configuration/statistics commands. */
export function wireStuckGuard(pi: ExtensionAPI, loadConfig: () => StuckGuardConfigLoad): void {
  let config: StuckGuardConfig = { ...DEFAULT_STUCK_GUARD_CONFIG };
  const cooldowns = new ProviderCooldownStore();
  const stats = new StuckGuardStats();
  const providerWrapperOptions = wrapperOptionsFrom(config, cooldowns, stats);
  const wrappedProviders = new Map<string, { original: Provider; wrapper: Provider }>();

  function configureProviders(ctx: ExtensionContext | undefined): void {
    const registry = ctx?.modelRegistry;
    if (!registry) return;
    const providerIds = config.streamWatchdogEnabled
      ? config.providerIds.length > 0
        ? new Set(config.providerIds)
        : new Set([
            ...registry.getRegisteredProviderIds(),
            ...registry.getAll().map((model) => model.provider),
          ])
      : new Set<string>();
    for (const [providerId, state] of wrappedProviders) {
      if (providerIds.has(providerId)) continue;
      const current = registry.getProvider(providerId);
      if (
        current === state.wrapper ||
        (current !== undefined && isWatchdogWrappedProvider(current))
      )
        registry.registerProvider(state.original);
      wrappedProviders.delete(providerId);
    }
    if (!config.streamWatchdogEnabled) return;
    for (const providerId of providerIds) {
      const provider = registry.getProvider(providerId);
      if (!provider) {
        ctx.ui.notify(`Error: Unknown provider: ${providerId}`, "error");
        continue;
      }
      if (
        wrappedProviders.get(providerId)?.wrapper === provider ||
        isWatchdogWrappedProvider(provider)
      )
        continue;
      const wrapper = wrapProvider(provider, providerWrapperOptions);
      registry.registerProvider(wrapper);
      wrappedProviders.set(providerId, { original: provider, wrapper });
    }
  }

  function reload(ctx: ExtensionContext | undefined): void {
    const loaded = loadConfig();
    if (loaded.ok) {
      config = loaded.config;
      Object.assign(providerWrapperOptions, wrapperOptionsFrom(config, cooldowns, stats));
      configureProviders(ctx);
      return;
    }
    config = { ...DEFAULT_STUCK_GUARD_CONFIG };
    Object.assign(providerWrapperOptions, wrapperOptionsFrom(config, cooldowns, stats));
    configureProviders(ctx);
    ctx?.ui.notify(`Error: ${loaded.error}; stuck-guard continues with defaults`, "error");
  }

  pi.on("session_start", (_event, ctx) => {
    stats.reset();
    reload(ctx);
  });

  registerStuckGuardCommand(pi, stats);

  pi.on("before_agent_start", (_event, ctx) => {
    reload(ctx);
  });
}

export default function stuckGuardExtension(pi: ExtensionAPI): void {
  wireStuckGuard(pi, () => loadStuckGuardConfig(getAgentDir()));
}

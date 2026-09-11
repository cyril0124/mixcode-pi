import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Provider, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
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
import { wireSchemaHint } from "./schema-hint.js";
import { wireDoomLoop } from "./doom-loop.js";
import { wireSearchGuard } from "./search-guard.js";

const SHARED_STATE = Symbol.for("mixcode.mpi-stuck-guard.sessions.v1");
const REGISTRATION = Symbol.for("mixcode.mpi-stuck-guard.registration.v1");

type PreviousRegistration =
  | { kind: "native"; provider: Provider }
  | {
      kind: "config";
      config: NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>>;
    }
  | { kind: "default" };

interface ProviderRegistration {
  wrapper: Provider;
  previous: PreviousRegistration;
}

type RegisteredProvider = Provider & { [REGISTRATION]?: ProviderRegistration };

interface SessionState {
  id: string;
  config: StuckGuardConfig;
  cooldowns: ProviderCooldownStore;
  stats: StuckGuardStats;
}

interface SharedState {
  sessions: Map<string, SessionState>;
  policy: StuckGuardConfig;
  warnedLegacy: WeakSet<Provider>;
}

/** Share session policy across registry facades and extension reloads.
 * Shutdown removes the matching session entry. Wrappers keep this lookup rather
 * than an ExtensionContext or a retired session's state.
 */
function sharedState(): SharedState {
  const host = globalThis as typeof globalThis & { [SHARED_STATE]?: SharedState };
  host[SHARED_STATE] ??= {
    sessions: new Map(),
    policy: { ...DEFAULT_STUCK_GUARD_CONFIG },
    warnedLegacy: new WeakSet(),
  };
  return host[SHARED_STATE];
}

function selectsProvider(config: StuckGuardConfig, providerId: string): boolean {
  return (
    config.streamWatchdogEnabled &&
    (config.providerIds.length === 0 || config.providerIds.includes(providerId))
  );
}

function wrapperOptionsFrom(
  config: StuckGuardConfig,
  cooldowns: ProviderCooldownStore,
  stats?: StuckGuardStats,
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
        stats?.recordProviderState(state);
      }
    },
    onTimeout: (_providerId, _modelId, kind) => stats?.recordProviderTimeout(kind),
  };
}

function requestOptions(
  shared: SharedState,
  providerId: string,
  options: StreamOptions | SimpleStreamOptions | undefined,
): ProviderWrapperOptions {
  const session = options?.sessionId ? shared.sessions.get(options.sessionId) : undefined;
  const config = session?.config ?? shared.policy;
  const cooldowns = session?.cooldowns ?? new ProviderCooldownStore();
  return {
    ...wrapperOptionsFrom(config, cooldowns, session?.stats),
    enabled: selectsProvider(shared.policy, providerId) && selectsProvider(config, providerId),
    // Unknown session IDs receive request-local protection and release cooldowns at settlement.
    ...(!session ? { onSettled: () => cooldowns.dispose() } : {}),
  };
}

function previousRegistration(registry: ModelRegistry, providerId: string): PreviousRegistration {
  const native = registry.getRegisteredNativeProvider(providerId);
  if (native) return { kind: "native", provider: native };
  const config = registry.getRegisteredProviderConfig(providerId);
  return config ? { kind: "config", config } : { kind: "default" };
}

function restoreRegistration(
  registry: ModelRegistry,
  providerId: string,
  registration: ProviderRegistration,
): void {
  // Restore only the registration owned by this watchdog; another extension may have replaced it.
  if (registry.getRegisteredNativeProvider(providerId) !== registration.wrapper) return;
  const previous = registration.previous;
  if (previous.kind === "native") registry.registerProvider(previous.provider);
  else if (previous.kind === "config") registry.registerProvider(providerId, previous.config);
  else registry.unregisterProvider(providerId);
}

function configureProviders(ctx: ExtensionContext, shared: SharedState): void {
  const registry = ctx.modelRegistry;
  const config = shared.policy;
  const selected = config.streamWatchdogEnabled
    ? new Set(
        config.providerIds.length > 0
          ? config.providerIds
          : [
              ...registry.getRegisteredProviderIds(),
              ...registry.getAll().map((model) => model.provider),
            ],
      )
    : new Set<string>();
  // Existing registrations remain candidates for removal after disable or filter changes,
  // including registrations installed by a previous extension instance.
  const providerIds = new Set([...registry.getRegisteredProviderIds(), ...selected]);
  for (const providerId of providerIds) {
    const native = registry.getRegisteredNativeProvider(providerId) as
      | RegisteredProvider
      | undefined;
    const registration = native?.[REGISTRATION];
    if (registration) {
      if (!selected.has(providerId)) restoreRegistration(registry, providerId, registration);
      continue;
    }
    if (!selected.has(providerId)) continue;
    const provider = registry.getProvider(providerId);
    if (!provider) {
      ctx.ui.notify(`Error: Unknown provider: ${providerId}`, "error");
      continue;
    }
    const marked = native ?? provider;
    if (isWatchdogWrappedProvider(marked)) {
      // Boolean-only wrappers lack the metadata needed to restore their original registration.
      if (!shared.warnedLegacy.has(marked)) {
        shared.warnedLegacy.add(marked);
        ctx.ui.notify("Error: Restart the host to replace an older watchdog registration", "error");
      }
      continue;
    }
    const previous = previousRegistration(registry, providerId);
    const wrapper = wrapProvider(provider, (options) =>
      requestOptions(shared, providerId, options),
    );
    Object.defineProperty(wrapper, REGISTRATION, {
      value: { wrapper, previous } satisfies ProviderRegistration,
    });
    // SDK composition can replace the effective provider object. The native registration
    // retains the wrapper identity used for deduplication.
    registry.registerProvider(wrapper);
  }
}

function retireSession(shared: SharedState, session: SessionState | undefined): void {
  if (!session) return;
  if (shared.sessions.get(session.id) === session) shared.sessions.delete(session.id);
  session.cooldowns.dispose();
}

/** Wire session-local tool protection and reuse one watchdog per native provider registration. */
export function wireStuckGuard(pi: ExtensionAPI, loadConfig: () => StuckGuardConfigLoad): void {
  const configureDoomLoop = wireDoomLoop(pi);
  const shared = sharedState();
  let session: SessionState | undefined;
  let stats = new StuckGuardStats();

  function reload(ctx: ExtensionContext, reset: boolean): void {
    const loaded = loadConfig();
    configureDoomLoop(loaded);
    const config = loaded.ok ? loaded.config : { ...DEFAULT_STUCK_GUARD_CONFIG };
    const id = ctx.sessionManager.getSessionId();
    if (reset || !session || session.id !== id) {
      retireSession(shared, session);
      retireSession(shared, shared.sessions.get(id));
      session = {
        id,
        config,
        cooldowns: new ProviderCooldownStore(),
        stats: new StuckGuardStats(),
      };
      shared.sessions.set(id, session);
      stats = session.stats;
    } else if (shared.sessions.get(id) !== session) {
      // The replacement factory owns this session ID; ignore callbacks from its predecessor.
      return;
    }
    session.config = config;
    shared.policy = config;
    configureProviders(ctx, shared);
    if (!loaded.ok)
      ctx.ui.notify(`Error: ${loaded.error}; watchdog uses defaults; tool calls blocked`, "error");
  }

  pi.on("session_start", (_event, ctx) => reload(ctx, true));
  pi.on("before_agent_start", (_event, ctx) => reload(ctx, false));
  pi.on("session_shutdown", () => retireSession(shared, session));
  registerStuckGuardCommand(pi, () => stats);
}

export default function stuckGuardExtension(pi: ExtensionAPI): void {
  wireStuckGuard(pi, () => loadStuckGuardConfig(getAgentDir()));
  wireSearchGuard(pi);
  wireSchemaHint(pi, () => loadStuckGuardConfig(getAgentDir()));
}

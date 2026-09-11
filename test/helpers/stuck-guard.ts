import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  type AssistantMessageEventStream,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionEvent,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { wireStuckGuard } from "../../pi-packages/mpi-stuck-guard/index.js";
import {
  DEFAULT_STUCK_GUARD_CONFIG,
  type StuckGuardConfig,
} from "../../pi-packages/mpi-stuck-guard/config.js";
import type { StuckGuardStatsSnapshot } from "../../pi-packages/mpi-stuck-guard/stats.js";

export function successfulStream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = fauxAssistantMessage("done", { stopReason: "stop" });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

/** Create an isolated SDK registry with a synthetic transport and in-memory credentials. */
export async function createWatchdogRegistry(configured = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "watchdog-registry-"));
  const providerId = `watchdog-${path.basename(dir)}`;
  const definitions = [{ id: "alpha", name: "Alpha", contextWindow: 100_000, maxTokens: 1000 }];
  const template = fauxProvider({ provider: providerId, models: definitions }).provider;
  let open = (_options?: SimpleStreamOptions) => successfulStream();
  let modelReads = 0;
  let requests = 0;
  const provider = Object.create(template) as Provider;
  Object.defineProperties(provider, {
    getModels: {
      value: () => {
        modelReads++;
        return template.getModels();
      },
    },
    stream: {
      value: (_model: unknown, _context: unknown, options?: SimpleStreamOptions) => {
        requests++;
        return open(options);
      },
    },
    streamSimple: {
      value: (_model: unknown, _context: unknown, options?: SimpleStreamOptions) => {
        requests++;
        return open(options);
      },
    },
  });
  const modelsPath = path.join(dir, "models.json");
  if (configured) {
    await Bun.write(
      modelsPath,
      JSON.stringify({
        providers: {
          [providerId]: {
            api: template.getModels()[0]!.api,
            apiKey: "offline-key",
            baseUrl: "http://127.0.0.1:9",
            headers: { "X-Watchdog-Test": "preserved" },
            models: definitions,
          },
        },
      }),
    );
  }
  const runtime = await ModelRuntime.create({
    modelsPath: configured ? modelsPath : null,
    credentials: new InMemoryCredentialStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  const model = registry.find(providerId, "alpha")!;
  return {
    dir,
    providerId,
    provider,
    runtime,
    registry,
    model,
    modelsPath,
    setOpen(next: (options?: SimpleStreamOptions) => AssistantMessageEventStream) {
      open = next;
    },
    get modelReads() {
      return modelReads;
    },
    get requests() {
      return requests;
    },
    request(sessionId?: string, options: SimpleStreamOptions = {}) {
      return runtime
        .streamSimple(model, { messages: [] }, { apiKey: "offline-key", sessionId, ...options })
        .result();
    },
    async dispose() {
      registry.unregisterProvider(providerId);
      await runtime.refresh({ allowNetwork: false });
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Provide extension callbacks and a rendered statistics view for SDK integration tests. */
export function createWatchdogSession(
  registry: ModelRegistry,
  overrides: Partial<StuckGuardConfig> = {},
  session = SessionManager.inMemory(),
) {
  let config = { ...DEFAULT_STUCK_GUARD_CONFIG, ...overrides };
  const handlers = new Map<string, ((event: ExtensionEvent, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<string, RegisteredCommand>();
  const notifications: string[] = [];
  let rendered = "";
  const pi = {
    on(name: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  const context = {
    modelRegistry: registry,
    sessionManager: session,
    hasUI: true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      async custom(
        factory: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: () => void,
        ) => { render(width: number): string[] },
      ) {
        const component = factory(
          {},
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          {},
          () => {},
        );
        rendered = component.render(100).join("\n");
      },
    },
  } as unknown as ExtensionCommandContext;
  wireStuckGuard(pi, () => ({ ok: true, config, path: "in-memory-config" }));
  const emit = async (type: "session_start" | "before_agent_start" | "session_shutdown") => {
    const event = {
      type,
      reason: type === "session_shutdown" ? "reload" : "startup",
    } as ExtensionEvent;
    for (const handler of handlers.get(type) ?? []) await handler(event, context);
  };
  return {
    session,
    context,
    notifications,
    emit,
    updateConfig(next: Partial<StuckGuardConfig>) {
      config = { ...config, ...next };
    },
    async stats(): Promise<StuckGuardStatsSnapshot> {
      await commands.get("stuck-guard")!.handler("stats", context);
      const count = (label: string) => {
        const match = rendered.match(new RegExp(`${label}: (\\d+)`));
        if (!match) throw new Error(`Missing statistic ${label}: ${rendered}`);
        return Number(match[1]);
      };
      return {
        providerAttempts: count("Provider attempts"),
        providerCompletions: count("Completed streams"),
        providerStartTimeouts: count("Start timeouts"),
        providerIdleTimeouts: count("Idle timeouts"),
        providerErrors: count("Provider errors"),
        providerUserAborts: count("User aborts"),
        retryCooldowns: count("Retry cooldown events"),
      };
    },
  };
}

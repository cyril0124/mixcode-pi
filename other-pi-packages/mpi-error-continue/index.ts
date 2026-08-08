import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_INVISIBLE = 3;
export const MAX_VISIBLE = 3;
export const BASE_DELAY_MS = 1000;
export const RESUME_CUSTOM_TYPE = "mpi-error-continue:resume";
export const STATE_CUSTOM_TYPE = "mpi-error-continue:state";
export const VISIBLE_CONTINUE_TEXT = "continue";
export const STATUS_KEY = "error-continue";
export const STATUS_PREFIX = "error-continue: on";
export const COMMAND_NAME = "error-continue";

const STATE_VERSION = 1;

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export type ErrorContinueOptions = {
  sleep?: SleepFn;
};

type AssistantMessageLike = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
};

type StateEvent = {
  version: number;
  enabled: boolean;
  at: number;
};

/** Phase-local exponential backoff: base * 2^attemptIndex0 → 1s / 2s / 4s. */
export function delayForAttempt(attemptIndex0: number, baseDelayMs = BASE_DELAY_MS): number {
  return baseDelayMs * 2 ** attemptIndex0;
}

/** Latest state entry wins; no entry → enabled (default on). */
export function readEnabledFromBranch(entries: readonly unknown[]): boolean {
  let enabled = true;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== STATE_CUSTOM_TYPE) continue;
    if (typeof candidate.data !== "object" || candidate.data === null) continue;
    const data = candidate.data as Partial<StateEvent>;
    if (data.version !== STATE_VERSION || typeof data.enabled !== "boolean") continue;
    enabled = data.enabled;
  }
  return enabled;
}

export function isResumeMarker(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown; customType?: unknown };
  return candidate.role === "custom" && candidate.customType === RESUME_CUSTOM_TYPE;
}

export function lastAssistant(messages: readonly unknown[]): AssistantMessageLike | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      typeof message === "object" &&
      message !== null &&
      (message as AssistantMessageLike).role === "assistant"
    ) {
      return message as AssistantMessageLike;
    }
  }
  return undefined;
}

function isVisibleContinueUserMessage(message: { content?: unknown }): boolean {
  const content = message.content;
  if (typeof content === "string") return content.trim() === VISIBLE_CONTINUE_TEXT;
  if (!Array.isArray(content)) return false;
  const text = content
    .filter((block): block is { type: "text"; text: string } => {
      if (typeof block !== "object" || block === null) return false;
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((block) => block.text)
    .join("");
  return text.trim() === VISIBLE_CONTINUE_TEXT;
}

export class SleepAbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "SleepAbortError";
  }
}

function isSleepAbort(error: unknown): boolean {
  return error instanceof SleepAbortError || (error instanceof Error && error.name === "SleepAbortError");
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SleepAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SleepAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createErrorContinueExtension(options: ErrorContinueOptions = {}) {
  const sleep = options.sleep ?? defaultSleep;

  return function errorContinue(pi: ExtensionAPI): void {
    // Default on until /error-continue off or a session branch state entry says otherwise.
    let enabled = true;
    let retryArmed = false;
    let invisibleUsed = 0;
    let visibleUsed = 0;
    let retryCount = 0;
    let pendingAutoContinue = false;
    let sleepAbort: AbortController | undefined;
    let inFlight = false;

    const clearPhaseCounters = () => {
      invisibleUsed = 0;
      visibleUsed = 0;
    };

    const abortSleep = () => {
      sleepAbort?.abort();
      sleepAbort = undefined;
    };

    const syncStatus = (ctx: {
      ui: { setStatus: (key: string, text: string | undefined) => void };
    }) => {
      ctx.ui.setStatus(STATUS_KEY, enabled ? `${STATUS_PREFIX} (${retryCount})` : undefined);
    };

    const noteRetry = (ctx: {
      ui: { setStatus: (key: string, text: string | undefined) => void };
    }) => {
      retryCount++;
      syncStatus(ctx);
    };

    const clearStatus = (ctx: {
      ui: { setStatus: (key: string, text: string | undefined) => void };
    }) => {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    };

    const persistEnabled = (next: boolean) => {
      const event: StateEvent = { version: STATE_VERSION, enabled: next, at: Date.now() };
      pi.appendEntry(STATE_CUSTOM_TYPE, event);
    };

    pi.registerCommand(COMMAND_NAME, {
      description: "Enable or disable automatic error-settle continues for this session",
      getArgumentCompletions: (prefix) => {
        const normalized = prefix.trim().toLowerCase();
        return [
          { label: "on", value: "on", description: "Enable automatic error-settle continues" },
          { label: "off", value: "off", description: "Disable automatic error-settle continues" },
        ].filter((entry) => entry.value.startsWith(normalized));
      },
      handler: async (args, ctx) => {
        const mode = args.trim().toLowerCase();
        if (mode === "on") {
          enabled = true;
          retryArmed = false;
          pendingAutoContinue = false;
          abortSleep();
          persistEnabled(true);
          syncStatus(ctx);
          ctx.ui.notify("Error continue enabled for this session.", "info");
          return;
        }
        if (mode === "off") {
          enabled = false;
          retryArmed = false;
          pendingAutoContinue = false;
          abortSleep();
          persistEnabled(false);
          syncStatus(ctx);
          ctx.ui.notify("Error continue disabled for this session.", "info");
          return;
        }
        ctx.ui.notify(`Usage: /${COMMAND_NAME} on|off`, "warning");
      },
    });

    pi.on("context", (event) => {
      const messages = event.messages.filter((message) => !isResumeMarker(message));
      if (messages.length !== event.messages.length) return { messages };
    });

    pi.on("message_start", (event) => {
      if (event.message.role !== "user") return;
      // Auto-sent visible "continue" must not reset phase counters.
      if (pendingAutoContinue && isVisibleContinueUserMessage(event.message)) {
        pendingAutoContinue = false;
        return;
      }
      pendingAutoContinue = false;
      retryArmed = false;
      clearPhaseCounters();
      abortSleep();
    });

    // Arm only from agent_end; fire on agent_settled so Pi auto-retry/compact finish first.
    pi.on("agent_end", (event) => {
      if (!enabled) {
        retryArmed = false;
        return;
      }
      const last = lastAssistant(event.messages);
      retryArmed = last?.stopReason === "error";
      if (!retryArmed) {
        clearPhaseCounters();
      }
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (!enabled || !retryArmed || inFlight) return;
      retryArmed = false;

      if (invisibleUsed < MAX_INVISIBLE) {
        const attempt = invisibleUsed + 1;
        const delayMs = delayForAttempt(invisibleUsed);
        invisibleUsed++;
        inFlight = true;
        abortSleep();
        sleepAbort = new AbortController();
        const signal = sleepAbort.signal;
        try {
          ctx.ui.notify(
            `Error settle; invisible continue ${attempt}/${MAX_INVISIBLE} after ${delayMs}ms.`,
            "warning",
          );
          await sleep(delayMs, signal);
          if (signal.aborted) return;
          pi.sendMessage(
            {
              customType: RESUME_CUSTOM_TYPE,
              content: [],
              display: false,
              details: {
                phase: "invisible",
                attempt,
                maxAttempts: MAX_INVISIBLE,
                delayMs,
              },
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
          noteRetry(ctx);
        } catch (error) {
          if (!isSleepAbort(error)) throw error;
        } finally {
          inFlight = false;
          if (sleepAbort?.signal === signal) sleepAbort = undefined;
        }
        return;
      }

      if (visibleUsed < MAX_VISIBLE) {
        const attempt = visibleUsed + 1;
        const delayMs = delayForAttempt(visibleUsed);
        visibleUsed++;
        inFlight = true;
        abortSleep();
        sleepAbort = new AbortController();
        const signal = sleepAbort.signal;
        try {
          ctx.ui.notify(
            `Error settle; visible continue ${attempt}/${MAX_VISIBLE} after ${delayMs}ms.`,
            "warning",
          );
          await sleep(delayMs, signal);
          if (signal.aborted) return;
          pendingAutoContinue = true;
          pi.sendUserMessage(VISIBLE_CONTINUE_TEXT, { deliverAs: "followUp" });
          noteRetry(ctx);
        } catch (error) {
          if (!isSleepAbort(error)) throw error;
        } finally {
          inFlight = false;
          if (sleepAbort?.signal === signal) sleepAbort = undefined;
        }
        return;
      }

      ctx.ui.notify(
        `Error continues exhausted (${MAX_INVISIBLE} invisible + ${MAX_VISIBLE} visible).`,
        "error",
      );
    });

    pi.on("session_start", (_event, ctx) => {
      enabled = readEnabledFromBranch(ctx.sessionManager.getBranch());
      retryArmed = false;
      pendingAutoContinue = false;
      retryCount = 0;
      clearPhaseCounters();
      abortSleep();
      inFlight = false;
      syncStatus(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      retryArmed = false;
      pendingAutoContinue = false;
      clearPhaseCounters();
      abortSleep();
      inFlight = false;
      clearStatus(ctx);
    });
  };
}

export default createErrorContinueExtension();

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_INVISIBLE = 3;
export const MAX_VISIBLE = 5;
export const BASE_DELAY_MS = 1000;
export const RESUME_CUSTOM_TYPE = "mpi-error-continue:resume";
export const STATE_CUSTOM_TYPE = "mpi-error-continue:state";
export const VISIBLE_CONTINUE_TEXT = "continue";
export const MIDWORK_CONTINUE_TEXT = "continue $simple-plan";
export const STATUS_KEY = "error-continue";
export const STATUS_PREFIX = "error-continue: on";
export const COMMAND_NAME = "error-continue";
/** Floor for the cancellable confirm window: a 1s dialog is not clickable. */
export const MIN_CONFIRM_MS = 5000;

const STATE_VERSION = 1;

/**
 * Outcome of one pre-send wait.
 * - "continue": timed out, or the user accepted -> send the continue.
 * - "cancel": the user dismissed the dialog (Esc / "No") -> stop this retry loop.
 * - "aborted": an external signal fired (shutdown, real user message,
 *   /error-continue on|off) -> send nothing and stay silent.
 */
export type ContinueDecision = "continue" | "cancel" | "aborted";

export type ContinueGate = (params: {
  ctx: ExtensionContext;
  title: string;
  message: string;
  delayMs: number;
  /** External cancel: shutdown, a real user message, or /error-continue on|off. */
  signal: AbortSignal;
}) => Promise<ContinueDecision>;

export type ErrorContinueOptions = {
  gate?: ContinueGate;
};

type RetryPhase = "invisible" | "visible" | "mid-work";

type AssistantMessageLike = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: unknown;
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

/**
 * Backoff raised to a floor the user can actually react to. The dialog timeout
 * doubles as the retry backoff, so the raw 1s/2s attempts would flash past
 * before Esc is reachable. Growth is preserved where it already exceeds the
 * floor (8s / 16s).
 */
export function confirmDelayForAttempt(attemptIndex0: number): number {
  return Math.max(delayForAttempt(attemptIndex0), MIN_CONFIRM_MS);
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

/** True when an assistant message has no output blocks: no text, thinking, or tool call. */
export function isEmptyResponse(message: { content?: unknown }): boolean {
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return true;
  return content.every((block) => {
    if (typeof block !== "object" || block === null) return true;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text") {
      return typeof candidate.text !== "string" || candidate.text.trim() === "";
    }
    return candidate.type !== "thinking" && candidate.type !== "toolCall";
  });
}

/** True when the last content block of an assistant message is a thinking block or a tool call. */
export function endsWithThinkingOrToolCall(message: { content?: unknown }): boolean {
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  const last = content[content.length - 1];
  if (typeof last !== "object" || last === null) return false;
  const type = (last as { type?: unknown }).type;
  return type === "thinking" || type === "toolCall";
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

/** Resolves true when the delay elapsed, false when `signal` aborted first. */
function waitFor(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Default gate: a countdown confirm dialog the user can dismiss with Esc.
 *
 * The dialog is the only Esc-reachable surface here. By the time `agent_settled`
 * fires, Pi has already cleared its run flag and MixCode has set the tab to
 * idle, so the host's Esc-abort branch does not apply and a plain timer would be
 * uncancellable. Extension shortcuts do not help either: the host consumes Esc
 * before extension shortcut dispatch.
 *
 * `confirm()` resolves false for all three of timeout, Esc, and "No", so
 * `timedOut` and the external `signal` are what tell them apart.
 */
export const confirmContinueGate: ContinueGate = async ({
  ctx,
  title,
  message,
  delayMs,
  signal,
}) => {
  if (signal.aborted) return "aborted";

  // No dialog surface (print / JSON mode): nobody can press Esc, so just wait.
  // Calling confirm() here would hit the no-op UI context, which resolves false
  // and would be misread as a user cancel, silently killing auto-recovery.
  if (!ctx.hasUI) return (await waitFor(delayMs, signal)) ? "continue" : "aborted";

  const dismiss = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    dismiss.abort();
  }, delayMs);
  const forwardAbort = () => dismiss.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });
  try {
    const answer = await ctx.ui.confirm(title, message, { signal: dismiss.signal });
    if (signal.aborted) return "aborted";
    if (timedOut || answer) return "continue";
    return "cancel";
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forwardAbort);
  }
};

export function createErrorContinueExtension(options: ErrorContinueOptions = {}) {
  const gate = options.gate ?? confirmContinueGate;

  return function errorContinue(pi: ExtensionAPI): void {
    // Default on until /error-continue off or a session branch state entry says otherwise.
    let enabled = true;
    let retryArmed = false;
    let midWorkArmed = false;
    let invisibleUsed = 0;
    let visibleUsed = 0;
    let retryCount = 0;
    let retryPhase: RetryPhase | undefined;
    let pendingAutoContinue = false;
    let waitAbort: AbortController | undefined;
    let inFlight = false;

    const clearPhaseCounters = () => {
      invisibleUsed = 0;
      visibleUsed = 0;
    };

    const abortWait = () => {
      waitAbort?.abort();
      waitAbort = undefined;
    };

    /** Own the wait window so external aborts (shutdown, user input) can cut it short. */
    const runGate = async (
      ctx: ExtensionContext,
      title: string,
      message: string,
      delayMs: number,
    ): Promise<ContinueDecision> => {
      inFlight = true;
      waitAbort = new AbortController();
      const signal = waitAbort.signal;
      try {
        return await gate({ ctx, title, message, delayMs, signal });
      } finally {
        inFlight = false;
        if (waitAbort?.signal === signal) waitAbort = undefined;
      }
    };

    const syncStatus = (ctx: {
      ui: { setStatus: (key: string, text: string | undefined) => void };
    }) => {
      if (!enabled) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const phase =
        retryPhase === "invisible"
          ? `invisible ${invisibleUsed}/${MAX_INVISIBLE}`
          : retryPhase === "visible"
            ? `visible ${visibleUsed}/${MAX_VISIBLE}`
            : retryPhase === "mid-work"
              ? "mid-work"
              : undefined;
      const progress = phase ? ` · ${phase}` : "";
      ctx.ui.setStatus(STATUS_KEY, `${STATUS_PREFIX}${progress} · total ${retryCount}`);
    };

    const noteRetry = (ctx: {
      ui: { setStatus: (key: string, text: string | undefined) => void };
    }) => {
      retryCount++;
      syncStatus(ctx);
    };

    const clearPhase = (ctx?: {
      ui: { setStatus: (key: string, text: string | undefined) => void };
    }) => {
      retryPhase = undefined;
      if (ctx) syncStatus(ctx);
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
          midWorkArmed = false;
          pendingAutoContinue = false;
          abortWait();
          clearPhase(ctx);
          persistEnabled(true);
          ctx.ui.notify("Error continue enabled for this session.", "info");
          return;
        }
        if (mode === "off") {
          enabled = false;
          retryArmed = false;
          midWorkArmed = false;
          pendingAutoContinue = false;
          abortWait();
          clearPhase(ctx);
          persistEnabled(false);
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

    pi.on("message_start", (event, ctx) => {
      if (event.message.role !== "user") return;
      // Auto-sent visible "continue" must not reset phase counters.
      if (pendingAutoContinue && isVisibleContinueUserMessage(event.message)) {
        pendingAutoContinue = false;
        return;
      }
      pendingAutoContinue = false;
      retryArmed = false;
      midWorkArmed = false;
      clearPhaseCounters();
      clearPhase(ctx);
      abortWait();
    });

    // Arm only from agent_end; fire on agent_settled so Pi auto-retry/compact finish first.
    pi.on("agent_end", (event, ctx) => {
      // User abort (ctx.signal.aborted) can land after a completed thinking/toolCall
      // assistant, so stopReason is not "aborted". Trust the run signal.
      if (!enabled || ctx.signal?.aborted) {
        retryArmed = false;
        midWorkArmed = false;
        pendingAutoContinue = false;
        abortWait();
        if (ctx.signal?.aborted) {
          clearPhaseCounters();
          clearPhase(ctx);
        }
        return;
      }
      const last = lastAssistant(event.messages);
      // Error stop, or a non-error stop that produced no output at all (the
      // "Agent finished without a response." case): use the error-settle flow.
      // User-initiated aborts stay untouched.
      retryArmed =
        last?.stopReason === "error" ||
        (!!last && last.stopReason !== "aborted" && isEmptyResponse(last));
      // Non-error stop that ended mid-work (last block is thinking or a tool call):
      // fire a single visible "continue $simple-plan" on settle.
      midWorkArmed =
        !retryArmed && !!last && last.stopReason !== "aborted" && endsWithThinkingOrToolCall(last);
      if (!retryArmed) {
        clearPhaseCounters();
        clearPhase(ctx);
      }
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (!enabled || inFlight) return;

      if (midWorkArmed) {
        midWorkArmed = false;
        retryPhase = "mid-work";
        syncStatus(ctx);
        const decision = await runGate(
          ctx,
          "Agent stopped mid-work",
          `Send "${MIDWORK_CONTINUE_TEXT}"? Esc cancels.`,
          MIN_CONFIRM_MS,
        );
        if (decision === "aborted") {
          clearPhase();
          return;
        }
        if (decision === "cancel") {
          clearPhase(ctx);
          ctx.ui.notify("Mid-work continue cancelled.", "info");
          return;
        }
        pi.sendUserMessage(MIDWORK_CONTINUE_TEXT, { deliverAs: "followUp" });
        noteRetry(ctx);
        return;
      }

      if (!retryArmed) return;
      retryArmed = false;

      // Cancel stops this backoff loop only: counters reset so the next real
      // error starts a fresh phase, and the extension stays enabled.
      const onCancel = () => {
        clearPhaseCounters();
        clearPhase(ctx);
        ctx.ui.notify("Error continue cancelled; this retry loop is stopped.", "info");
      };

      if (invisibleUsed < MAX_INVISIBLE) {
        const attempt = invisibleUsed + 1;
        const delayMs = confirmDelayForAttempt(invisibleUsed);
        invisibleUsed++;
        retryPhase = "invisible";
        syncStatus(ctx);
        const decision = await runGate(
          ctx,
          `No response — invisible continue ${attempt}/${MAX_INVISIBLE}`,
          "Resume the agent? Esc stops this retry loop.",
          delayMs,
        );
        if (decision === "aborted") {
          clearPhase();
          return;
        }
        if (decision === "cancel") return onCancel();
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
        return;
      }

      if (visibleUsed < MAX_VISIBLE) {
        const attempt = visibleUsed + 1;
        const delayMs = confirmDelayForAttempt(visibleUsed);
        visibleUsed++;
        retryPhase = "visible";
        syncStatus(ctx);
        const decision = await runGate(
          ctx,
          `No response — visible continue ${attempt}/${MAX_VISIBLE}`,
          `Send "${VISIBLE_CONTINUE_TEXT}"? Esc stops this retry loop.`,
          delayMs,
        );
        if (decision === "aborted") {
          clearPhase();
          return;
        }
        if (decision === "cancel") return onCancel();
        pendingAutoContinue = true;
        pi.sendUserMessage(VISIBLE_CONTINUE_TEXT, { deliverAs: "followUp" });
        noteRetry(ctx);
        return;
      }

      clearPhase(ctx);
      ctx.ui.notify(
        `Continue attempts exhausted (${MAX_INVISIBLE} invisible + ${MAX_VISIBLE} visible).`,
        "error",
      );
    });

    pi.on("session_start", (_event, ctx) => {
      enabled = readEnabledFromBranch(ctx.sessionManager.getBranch());
      retryArmed = false;
      midWorkArmed = false;
      pendingAutoContinue = false;
      retryCount = 0;
      retryPhase = undefined;
      clearPhaseCounters();
      abortWait();
      inFlight = false;
      syncStatus(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      retryArmed = false;
      midWorkArmed = false;
      pendingAutoContinue = false;
      retryPhase = undefined;
      clearPhaseCounters();
      abortWait();
      inFlight = false;
      clearStatus(ctx);
    });
  };
}

export default createErrorContinueExtension();

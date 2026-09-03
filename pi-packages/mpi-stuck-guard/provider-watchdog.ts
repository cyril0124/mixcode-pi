export type ProviderWatchdogState =
  | "idle"
  | "streaming"
  | "timed_out"
  | "user_aborted"
  | "completed"
  | "provider_error"
  | "cooldown_short_window";

export type ProviderWatchdogTimeoutKind = "start" | "idle";

type Timer = ReturnType<typeof setTimeout>;

function cooldownKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/** Session-local provider/model cooldown. One store per `wireStuckGuard` instance. */
export class ProviderCooldownStore {
  private readonly timers = new Map<string, Timer>();
  private readonly expires = new Map<string, number>();

  isOnCooldown(providerId: string, modelId: string): boolean {
    const key = cooldownKey(providerId, modelId);
    const expiresAt = this.expires.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt !== Number.POSITIVE_INFINITY && expiresAt <= Date.now()) {
      this.clear(providerId, modelId);
      return false;
    }
    return true;
  }

  clear(providerId: string, modelId: string): void {
    const key = cooldownKey(providerId, modelId);
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
    this.expires.delete(key);
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.expires.clear();
  }

  set(providerId: string, modelId: string, durationMs: number): void {
    const key = cooldownKey(providerId, modelId);
    this.clear(providerId, modelId);
    if (durationMs === 0) {
      this.expires.set(key, Number.POSITIVE_INFINITY);
      return;
    }
    this.expires.set(key, Date.now() + durationMs);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.expires.delete(key);
    }, durationMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }
}

export interface ProviderWatchdogOptions {
  providerId: string;
  modelId: string;
  /** Milliseconds before the first provider event. `0` disables this timer. */
  streamStartTimeoutMs: number;
  /** Milliseconds allowed between provider events. `0` disables this timer. */
  streamIdleTimeoutMs: number;
  /** Milliseconds before the first event after a known timeout. */
  streamRetryStartTimeoutMs: number;
  /** Milliseconds to retain the known-timeout cooldown. */
  knownTimeoutCooldownMs: number;
  cooldowns: ProviderCooldownStore;
  signal?: AbortSignal;
  onTimeout?: (kind: ProviderWatchdogTimeoutKind) => void;
  onUserAbort?: () => void;
  onStateChange?: (state: ProviderWatchdogState) => void;
}

/** Owns the liveness timers for one provider request. Retry remains host-owned. */
export class ProviderWatchdog {
  private readonly timers = new Set<Timer>();
  private readonly removeAbortListener?: () => void;
  private _state: ProviderWatchdogState;
  private _timeoutKind: ProviderWatchdogTimeoutKind | undefined;
  private disposed = false;
  private readonly onCooldownAtStart: boolean;

  constructor(private readonly options: ProviderWatchdogOptions) {
    this.onCooldownAtStart = options.cooldowns.isOnCooldown(options.providerId, options.modelId);
    this._state = this.onCooldownAtStart ? "cooldown_short_window" : "idle";
    if (options.signal) {
      const onAbort = () => this.userAbort();
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) queueMicrotask(onAbort);
    }
  }

  get state(): ProviderWatchdogState {
    return this._state;
  }

  get timeoutKind(): ProviderWatchdogTimeoutKind | undefined {
    return this._timeoutKind;
  }

  get timerCount(): number {
    return this.timers.size;
  }

  /** Start one request. A cooldown only changes the first-event timeout. */
  beginAttempt(): boolean {
    if (this.disposed || this._state === "user_aborted") return false;
    this.clearRequestTimers();
    this.setState("idle");
    this.schedule(
      this.onCooldownAtStart
        ? this.options.streamRetryStartTimeoutMs
        : this.options.streamStartTimeoutMs,
      "start",
    );
    return true;
  }

  onEvent(): boolean {
    if (this.disposed || (this._state !== "idle" && this._state !== "streaming")) return false;
    this.clearRequestTimers();
    this.setState("streaming");
    this.schedule(this.options.streamIdleTimeoutMs, "idle");
    return true;
  }

  complete(): void {
    if (this.disposed) return;
    this.clearRequestTimers();
    this.setState("completed");
    this.dispose();
  }

  providerError(): void {
    if (this.disposed) return;
    this.clearRequestTimers();
    this.setState("provider_error");
    this.dispose();
  }

  timeout(kind: ProviderWatchdogTimeoutKind): void {
    if (this.disposed || (this._state !== "idle" && this._state !== "streaming")) return;
    this.clearRequestTimers();
    this._timeoutKind = kind;
    this.options.cooldowns.set(
      this.options.providerId,
      this.options.modelId,
      this.options.knownTimeoutCooldownMs,
    );
    this.setState("timed_out");
    this.options.onTimeout?.(kind);
  }

  userAbort(): void {
    if (this.disposed || this._state === "completed" || this._state === "provider_error") return;
    this.clearRequestTimers();
    this.setState("user_aborted");
    this.options.onUserAbort?.();
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRequestTimers();
    this.removeAbortListener?.();
  }

  private schedule(durationMs: number, kind: ProviderWatchdogTimeoutKind): void {
    if (durationMs === 0 || this.disposed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.timeout(kind);
    }, durationMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private clearRequestTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private setState(state: ProviderWatchdogState): void {
    this._state = state;
    this.options.onStateChange?.(state);
  }
}

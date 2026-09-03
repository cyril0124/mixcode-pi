export interface StuckGuardStatsSnapshot {
  providerAttempts: number;
  providerCompletions: number;
  providerStartTimeouts: number;
  providerIdleTimeouts: number;
  providerErrors: number;
  providerUserAborts: number;
  retryCooldowns: number;
}

function emptyStats(): StuckGuardStatsSnapshot {
  return {
    providerAttempts: 0,
    providerCompletions: 0,
    providerStartTimeouts: 0,
    providerIdleTimeouts: 0,
    providerErrors: 0,
    providerUserAborts: 0,
    retryCooldowns: 0,
  };
}

/** Session-local counters for provider stream outcomes. */
export class StuckGuardStats {
  private values = emptyStats();

  reset(): void {
    this.values = emptyStats();
  }

  recordProviderTimeout(kind: "start" | "idle"): void {
    if (kind === "start") this.values.providerStartTimeouts++;
    else this.values.providerIdleTimeouts++;
    this.values.retryCooldowns++;
  }

  recordProviderState(state: "idle" | "completed" | "provider_error" | "user_aborted"): void {
    if (state === "idle") this.values.providerAttempts++;
    else if (state === "completed") this.values.providerCompletions++;
    else if (state === "provider_error") this.values.providerErrors++;
    else this.values.providerUserAborts++;
  }

  snapshot(): StuckGuardStatsSnapshot {
    return { ...this.values };
  }
}

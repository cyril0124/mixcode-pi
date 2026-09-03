# mpi-stuck-guard

`mpi-stuck-guard` protects provider stream liveness. It watches the first provider event and the idle gap between events, aborts stalled requests, and returns a retryable error to the host retry mechanism.

## Provider stream watchdog

The watchdog wraps the public `Provider.stream` and `Provider.streamSimple` APIs. Normal events pass through unchanged. Each request has independent start, idle, abort, and completion state.

### Provider stream states

| State | Meaning | Terminal? |
|---|---|---|
| `idle` | Request started; no provider event received | No |
| `streaming` | At least one event received; idle timer is armed | No |
| `timed_out` | Start or idle watchdog fired; original request was aborted | Yes for this request |
| `user_aborted` | Parent signal cancelled the request | Yes |
| `completed` | Provider emitted `done` | Yes |
| `provider_error` | Provider emitted a non-watchdog error or threw | Yes |
| `cooldown_short_window` | This provider/model recently timed out; the next request uses the retry start window | No |

### Provider stream state transitions

```text
idle
  ├─ first event arrives ───────────────> streaming
  ├─ streamStartTimeoutSeconds expires ─> timed_out
  └─ parent AbortSignal fires ──────────> user_aborted

streaming
  ├─ another event arrives ─────────────> streaming
  ├─ provider emits done ───────────────> completed
  ├─ provider emits error/throws ───────> provider_error
  ├─ streamIdleTimeoutSeconds expires ──> timed_out
  └─ parent AbortSignal fires ──────────> user_aborted

timed_out
  ├─ abort original provider request
  ├─ record provider/model cooldown
  └─ emit error(stopReason="error")
          │
          ▼
      host retry
       ├─ request succeeds ─────────────> streaming / completed
       └─ retry budget exhausted ───────> host reports `Error: Retry failed`

cooldown_short_window
  ├─ next request uses streamRetryStartTimeoutSeconds
  └─ knownTimeoutCooldownSeconds expires ─> normal start window
```

Timeout calls the request-local `AbortController` and invokes `iterator.return()` before emitting the error. Providers that honor the public `signal` contract stop their underlying request; a provider that ignores both signal and iterator cleanup cannot be forcibly killed by an extension. User aborts retain `stopReason: "aborted"`. The watchdog does not implement a second retry counter or backoff policy.

## Scenarios

| Scenario | Trigger | Result |
|---|---|---|
| Stream start timeout | A provider never emits its first event | The request is aborted and a retryable error is emitted |
| Stream idle timeout | A provider emits an event and then stops | The request is aborted after the idle gap and enters the host retry path |
| Thinking stall | A provider emits thinking content and then stops | Thinking remains visible, then the idle watchdog reports a timeout |
| Retry exhausted | Every provider attempt times out | Host retry reaches its configured limit and reports `Retry failed`; it does not retry forever |
| User abort | The parent request is cancelled by the user | The stream ends as `aborted`, not watchdog `error` |
| Retry cooldown | A timeout records a provider/model cooldown | The next request uses `streamRetryStartTimeoutSeconds`; after cooldown expiry, the normal start timeout is used |
| Timeout disabled | Start, idle, and retry-start timeout values are set to `0` | A slow stream completes without a watchdog timeout |
| Provider filter | `providerIds` limits wrapping to selected providers | Selected providers are watched; an unknown ID reports `Error: Unknown provider` |
| Invalid configuration | The configuration contains an unknown key, invalid type, or invalid value | An `Error:` notification appears; the watchdog reports the error and continues with explicit defaults |
| Configuration page | `/stuck-guard config` is entered | A bordered configuration page opens in the Editor area and saves valid edits |
| Provider picker | Provider IDs are edited from the configuration page | Text filters the list, Enter toggles IDs, and Esc saves; `j`/`k` enter search text, while arrow keys navigate |
| Statistics page | `/stuck-guard stats` is entered | A read-only Editor page shows current-session watchdog counters |

## Configuration

Config lives at `<agentDir>/mpi-stuck-guard.json`. Missing keys use defaults. Unknown keys, invalid types, and invalid values surface an error; the watchdog continues with explicit defaults instead of silently disabling protection.

```json
{
  "$schema": "./mpi-stuck-guard.schema.json",
  "streamWatchdogEnabled": true,
  "providerIds": [],
  "streamStartTimeoutSeconds": 300,
  "streamIdleTimeoutSeconds": 300,
  "streamRetryStartTimeoutSeconds": 300,
  "knownTimeoutCooldownSeconds": 60
}
```

| Key | Type | Default | Meaning |
|---|---|---:|---|
| `streamWatchdogEnabled` | boolean | `true` | Enables provider stream start and idle timeouts |
| `providerIds` | string[] | `[]` | Providers to wrap; empty means all configured providers |
| `streamStartTimeoutSeconds` | integer >= 0 | `300` | Maximum wait for the first provider event; `0` disables it |
| `streamIdleTimeoutSeconds` | integer >= 0 | `300` | Maximum gap between provider events; `0` disables it |
| `streamRetryStartTimeoutSeconds` | integer >= 0 | `300` | First-event window after a known timeout in this session; `0` disables it |
| `knownTimeoutCooldownSeconds` | integer >= 0 | `60` | How long this session keeps the retry start window; `0` keeps it for the session. Not shared across tabs |

The host still owns retry settings in `settings.json`:

| Setting | Owner |
|---|---|
| `retry.enabled` | Enables host retry |
| `retry.maxRetries` | Agent-level retry count |
| `retry.baseDelayMs` | Agent-level backoff |
| `retry.provider.maxRetries` | Provider SDK retry count |
| `retry.provider.maxRetryDelayMs` | Maximum provider retry-after delay |

These settings are not duplicated or overridden by `mpi-stuck-guard`.

## Commands

Use these forms:

```text
/stuck-guard          # shortcut for config
/stuck-guard config   # open the configuration page
/stuck-guard stats    # open current-session statistics
```

`/stuck-guard config` opens the configuration page in the Editor area. Arguments other than `config` and `stats` are rejected. The page lets you edit every watchdog setting and select Provider IDs through a searchable multi-select list.

`/stuck-guard stats` opens a read-only Editor page. It shows current-session counts for provider attempts, completed streams, start timeouts, idle timeouts, provider errors, user aborts, and retry cooldown events. Statistics are kept in memory and reset when the session starts; they are not written to `mpi-stuck-guard.json`.

Invalid values are not written. For example, `streamIdleTimeoutSeconds` must be an integer greater than or equal to `0`; an invalid value shows an `Error:` notification and preserves the previous value.

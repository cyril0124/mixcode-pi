# mpi-stuck-guard

`mpi-stuck-guard` blocks oversized recursive searches, detects repeated identical tool calls, aborts stalled provider streams through the host retry path, and steers the model after repeated parameter-validation failures.

## Doom loop

`doomLoop` in `<agentDir>/mpi-stuck-guard.json` controls repeated-call protection for all projects. Settings are global; each session has its own counter.

```json
{
  "doomLoop": {
    "action": "deny",
    "message": "Change the input before retrying."
  }
}
```

The threshold is fixed at 3: the action applies to the third and each subsequent consecutive call with the same tool name and byte-identical `JSON.stringify(input)`. Successful and failed calls both count. A different tool or input resets the count to 1; user messages and model replies leave it unchanged.

`session_start` clears the counter. Settings reload on `session_start` and `before_agent_start`; disabling and re-enabling starts a new count.

| Action | Result |
|---|---|
| `allow` | Disabled; also the default when `doomLoop` is absent. |
| `ask` | Offer Allow once / Reject. Allow once leaves the count unchanged, so the next identical call asks again. Esc, cancellation, dialog failure, or missing UI blocks the call. |
| `deny` | Block from the third call with a `stuck-guard: doom_loop` reason. Append optional `message` on a new line. |

`action` is required. Optional `message` is a literal string that accepts empty text and newlines. Unknown fields and invalid types are configuration errors. Messages are saved but displayed only for automatic `deny`, not for `allow`, `ask`, or user rejection.

Edit the JSON object under Doom loop in `/stuck-guard config`. Saved changes apply on the next agent turn.

Pi stops dispatching `tool_call` after an extension blocks it. This guard counts only calls that reach it, excluding earlier validation failures and extension blocks. Permission probes count like any other tool, but their results cover [permission rules](../mpi-permission/README.md#permission-probe), not this guard.

Permission and doom-loop approvals are separate; a call may require both. Watchdog statistics exclude doom-loop counts.

## Search guard

The search guard intercepts `bash`, `grep`, and `find` tool calls before execution and blocks recursive searches rooted at high-cardinality directories (`/`, `/home`, `/etc`, `/usr`, `/var`, `/tmp`, `/opt`, `/nfs`, `~`, and the home parent). Blocked calls return a reason telling the agent to narrow the path to a specific subdirectory. Bash command inspection handles heredocs, comments, quotes, command splitting (`;`, `&&`, `||`, pipes), `sudo`/`env` prefixes, and redirections; it parses `grep`/`rg`/`find`/`fd`/`ag`/`ack` arguments to locate path positionals.

## Schema hint

When the same tool fails parameter validation on `schemaHintFailureThreshold` (default 2) consecutive calls, the guard distills that tool's parameter schema into a compact contract (required fields, per-level field names and types, optional fields marked `(optional)`, `enum`/`anyOf` folded to `a|b`, capped at 15 property lines and 2 nesting levels) and injects it as a hidden steering message so the model re-issues the call with correct arguments. Detection rides on `tool_execution_end` with an error text starting `Validation failed for tool "` (the observable contract of pi-ai's argument validation; validation failures do not fire the `tool_result` extension event). One hint per failure streak: any successful or non-validation call to the tool resets the counter and re-arms the hint; `session_start` clears all counters. A toast (`[stuck-guard] injected <tool> parameter contract hint`) marks each injection. The threshold is read from `mpi-stuck-guard.json` (editable via `/stuck-guard config`) and reloaded on `session_start` / `before_agent_start`.

## Provider stream watchdog

The watchdog wraps the public `Provider.stream` and `Provider.streamSimple` APIs. Normal events pass through unchanged. Each request has independent start, idle, abort, and completion state.

### Provider registration and session ownership

Each provider in the shared `ModelRuntime` has at most one native watchdog registration. `session_start` and `before_agent_start` find and reuse it through `getRegisteredNativeProvider`.

Each stream uses `StreamOptions.sessionId` to select its configuration, counters, and cooldown store. Missing or unknown IDs, including independently generated summary routing IDs, receive request-local protection with no session counters or retained cooldowns. Each request keeps the policy and callbacks captured when its stream opened.

`session_shutdown` removes the matching session state and clears its cooldown timers. A delayed shutdown from an earlier instance preserves the replacement session's state. Disabling the watchdog or narrowing `providerIds` restores the previous native, configured, or default registration only if the current registration is still the extension's wrapper. Registrations installed by other extensions are preserved.

Boolean-only watchdog registrations require a host restart because they lack the original registration metadata. The extension reports `Error: Restart the host to replace an older watchdog registration` and preserves the registration. After background tasks finish, exit normally and launch the updated executable in the same workdir to restore saved sessions. `/reload` retains the model runtime and may retain these wrapper chains.

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
| Invalid configuration | The configuration contains an unknown key, invalid type, or invalid value | An `Error:` notification appears; tool calls are blocked until a valid reload, while the watchdog uses explicit defaults |
| Configuration page | `/stuck-guard config` is entered | A bordered configuration page opens in the Editor area and saves valid edits |
| Provider picker | Provider IDs are edited from the configuration page | Text filters the list, Enter toggles IDs, and Esc saves; `j`/`k` enter search text, while arrow keys navigate |
| Statistics page | `/stuck-guard stats` is entered | A read-only Editor page shows current-session watchdog counters |

## Configuration

Config lives at `<agentDir>/mpi-stuck-guard.json`. Missing keys use defaults. Unreadable files, invalid JSON, unknown keys, invalid types, and invalid values surface an error and block tool calls until a successful reload; the watchdog continues with explicit defaults.

```json
{
  "$schema": "./mpi-stuck-guard.schema.json",
  "streamWatchdogEnabled": true,
  "providerIds": [],
  "streamStartTimeoutSeconds": 300,
  "streamIdleTimeoutSeconds": 300,
  "streamRetryStartTimeoutSeconds": 300,
  "knownTimeoutCooldownSeconds": 60,
  "doomLoop": { "action": "allow" },
  "schemaHintFailureThreshold": 2
}
```

| Key | Type | Default | Meaning |
|---|---|---:|---|
| `doomLoop` | object | `{ "action": "allow" }` | Repeated-call action and optional denial message; see [Doom loop](#doom-loop) |
| `streamWatchdogEnabled` | boolean | `true` | Enables provider stream start and idle timeouts |
| `providerIds` | string[] | `[]` | Providers to wrap; empty means all configured providers |
| `streamStartTimeoutSeconds` | integer >= 0 | `300` | Maximum wait for the first provider event; `0` disables it |
| `streamIdleTimeoutSeconds` | integer >= 0 | `300` | Maximum gap between provider events; `0` disables it |
| `streamRetryStartTimeoutSeconds` | integer >= 0 | `300` | First-event window after a known timeout in this session; `0` disables it |
| `knownTimeoutCooldownSeconds` | integer >= 0 | `60` | How long this session keeps the retry start window; `0` keeps it for the session. Not shared across tabs |
| `schemaHintFailureThreshold` | integer >= 1 | `2` | Consecutive validation failures of the same tool before the schema hint is injected |

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

`/stuck-guard config` opens the configuration page in the Editor area. Arguments other than `config` and `stats` are rejected. The page lets you edit watchdog settings, the Doom loop JSON object, and the schema-hint threshold, and select Provider IDs through a searchable multi-select list.

`/stuck-guard stats` opens a read-only Editor page. It shows current-session counts for provider attempts, completed streams, start timeouts, idle timeouts, provider errors, user aborts, and retry cooldown events. Statistics are kept in memory and reset when the session starts; they are not written to `mpi-stuck-guard.json`.

Invalid values are not written. For example, `streamIdleTimeoutSeconds` must be an integer greater than or equal to `0`; an invalid value shows an `Error:` notification and preserves the previous value.

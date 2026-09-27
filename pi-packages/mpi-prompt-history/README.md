# mpi-prompt-history

Sole producer of MixCode's prompt-recall files, plus the `/prompt-history` browser.

## Files

Prompt-recall data and lock files live in `<agentDir>/mpi-prompt-history/` (`agentDir` follows `PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

| File | Shape | Written when |
| --- | --- | --- |
| `history.jsonl` | `{"session_id": string, "ts": number (unix seconds), "text": string}` | every recorded submit, and on backfill |
| `session_index.jsonl` | `{"id", "title", "updated_at", "path", "cwd"}`, newest `updated_at` first | index missing, a scanned session path is absent, a session file is newer than the index, or the current session is upserted |
| `.locks/prompt-history.lock` | PID lock record | held during every read-modify-write of `history.jsonl` |

New prompts append to `history.jsonl`. History rewrites and index updates use a temporary file and atomic rename. Data files have mode `0600`; the data directory is `0700`. `title` falls back through session name -> first user message -> session id.

## Behavior

| Event | Action |
| --- | --- |
| `input` (`source: "interactive"`) | append the raw submitted text to `history.jsonl`, then trim to the byte budget |
| `session_start` | once per sessions root per process: backfill the last 30 days from session JSONL (deduplicated on `session_id`+`ts`+`text`), rebuild a stale index, and upsert the current session record |
| `before_agent_start` | set `systemPromptOptions.sections["mpi-prompt-history"]` to a section naming both file paths |

Startup covers both the active session's file directory and the current workdir's default Pi session directory, scanning each distinct root once per process. Changing workdir can leave the active session file in its original directory. The index is shared across workdirs. A newer index timestamp does not establish coverage: missing session paths also trigger a rebuild. Rebuilds merge records by session id under the shared lock, retaining the newest metadata and preserving other workdirs and live sessions not yet flushed to disk.

Background scans and prompt writes capture the originating session's identity before I/O and may finish after session replacement or reload. `session_shutdown` disables notifications for that session. Shared scans store results independently of UI contexts; each active session waiting for a scan reports its warnings.

A rebuild processes one session file at a time and retains only user-prompt candidates and index metadata between files. Retained strings are copied out of the file's backing storage. Parsing yields to the event loop between JSONL rows after roughly 10 ms of work; parsing an individual row remains synchronous. The 30-day cutoff is evaluated once after the scan. Both recording and backfill trim history with a linear UTF-8 byte count, preserving complete newest rows within the configured budget. Backfill serializes only the rows that survive trimming.

The pointer block contains paths only, never history content. Pi persists it with the structured prompt, so later extension contributions remain effective and unchanged pointers do not produce repeated prompt updates.

## Commands

| Command | Effect |
| --- | --- |
| `/prompt-history` | Open the browser in Session scope. |
| `/prompt-history config` | Edit the config below: pick `maxBytes` to enter a new size, or reset it to the default. |

Press `/` to search with a case-insensitive JavaScript regular expression. Invalid expressions are shown in the browser. Arrow keys still move. `j`, `k`, `c`, and `q` type into the query. `Ctrl+G` cycles Session, Workdir, and Global while keeping the query.

| Key | Action |
| --- | --- |
| `j` / `k` or ↑ / ↓ | Next / previous item |
| `Ctrl+D` / `Ctrl+U` | Half page down / up |
| `g` / `G` | First / last item |
| `/` | Open search |
| Enter | Insert the selected prompt |
| `c` | Copy the selected prompt to the clipboard and close |
| `Ctrl+G` | Cycle Session / Workdir / Global |
| Esc | Cancel search, or close |
| `q` | Close |

| Scope | Source | Notes |
| --- | --- | --- |
| Session | `ctx.sessionManager` entries | Current session only; never touches `history.jsonl`. |
| Workdir | `session_index.jsonl` joined to `history.jsonl` | Sessions whose normalized `cwd` matches the current workdir exactly; excludes subdirectories and other worktrees. Distinct text at its most recent time within this scope, newest first. |
| Global | `history.jsonl` | Every recorded prompt, one entry per distinct text at its most recent time, newest first. |

Workdir and Global load on first switch and show a loading message while reading. Workdir waits for session-start backfill and indexing before taking its snapshot; tabs sharing a root join the same pending scan. Each scope keeps its snapshot until the browser closes; a failed load retries when re-entered. Switching keeps the search query and selects the first result, and the Workdir title shows the current path. Both scopes read the data files only, so the browser opens no session transcript, and neither locks nor rewrites a file. The session index is refreshed when a session starts, so a new session appears in Workdir on the next open; rows missing from the index are not inferred. Matching resolves `.` / `..` and trailing separators without resolving symlinks. Repeats dominate the raw log, so both scopes collapse them to the most recent occurrence within the scope.

`config` accepts plain bytes or a unit suffix (`20mb`, `512 KB`, `1048576`) and rejects anything that is not a positive whole number of bytes.

## Activation gate

Recording, backfill, and injection run only when all three hold:

- `MIXCODE` is set and not `0`/`false`/`off`. This excludes upstream `pi`, which also loads this package.
- `MIXCODE_PID` equals this process's PID. This excludes child processes that inherit the host environment.
- `ctx.mode === "tui"`. In-process subagents are created without a mode and report `"print"`. Their `input` events also report `source: "interactive"`, so the source filter alone cannot exclude them.

`/prompt-history` is available regardless of these conditions.

Subagent prompts are not recorded. Subagents can inherit the history file paths through their parent system prompt, even though this package does not inject them into subagent sessions.

## Configuration

`<agentDir>/mpi-prompt-history.json`, owned entirely by this package. The file is optional.

```jsonc
{
  "$schema": "./mpi-prompt-history.schema.json",
  "maxBytes": 15728640
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxBytes` | positive integer | `15728640` (15 MiB) | Byte budget for `history.jsonl`. Oldest rows are trimmed once the file exceeds it. |
| `$schema` | string | none | Optional editor hint; ignored at runtime. |

A missing file or missing `maxBytes` uses the default. Invalid JSON, a non-object root, an unknown key, or a `maxBytes` that is not a positive integer produces an error naming the configuration file.

Use `/prompt-history config` or edit the file directly. This package's configuration is separate from `mixcode_settings.json` and `/settings`.

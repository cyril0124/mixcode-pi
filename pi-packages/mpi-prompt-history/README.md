# mpi-prompt-history

Sole producer of MixCode's prompt-recall files, plus the `/prompt-history` browser.

## Files

Both live in the package's own data dir, `<agentDir>/mpi-prompt-history/` (`agentDir` follows `PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

| File | Shape | Written when |
| --- | --- | --- |
| `history.jsonl` | `{"session_id": string, "ts": number (unix seconds), "text": string}` | every recorded submit, and on backfill |
| `session_index.jsonl` | `{"id", "title", "updated_at", "path", "cwd"}`, newest `updated_at` first | index missing, or a session file is newer than the index |
| `.locks/prompt-history.lock` | PID lock record | held during every read-modify-write of `history.jsonl` |

Files are written atomically (temp + rename) with mode `0600`; the data dir is `0700`. `title` falls back through session name -> first user message -> session id.

## Behavior

| Event | Action |
| --- | --- |
| `input` (`source: "interactive"`) | append the raw submitted text to `history.jsonl`, then trim to the byte budget |
| `session_start` | once per sessions root per process: backfill the last 30 days from session JSONL (deduplicated on `session_id`+`ts`+`text`) and rebuild the index when stale |
| `before_agent_start` | append a five-line pointer block naming both file paths to the system prompt |

The pointer block contains paths only, never history content.

## Commands

| Command | Effect |
| --- | --- |
| `/prompt-history` | Open the browser in **Session** scope. |
| `/prompt-history config` | Edit the config below: pick `maxBytes` to enter a new size, or reset it to the default. |

Press `/` to search. Arrow keys still move. `j`, `k`, and `q` type into the query. `Ctrl+G` switches Session and Global and keeps the query.

| Key | Action |
| --- | --- |
| `j` / `k` or ↑ / ↓ | Next / previous item |
| `Ctrl+D` / `Ctrl+U` | Half page down / up |
| `g` / `G` | First / last item |
| `/` | Open search |
| Enter | Insert the selected prompt |
| `Ctrl+G` | Toggle Session / Global |
| Esc | Cancel search, or close |
| `q` | Close |

| Scope | Source | Notes |
| --- | --- | --- |
| Session | `ctx.sessionManager` entries | Current session only; never touches `history.jsonl`. |
| Global | `history.jsonl` | Every recorded prompt, one entry per distinct text at its most recent time, newest first. |

Global loads on first switch, not at open, and renders a placeholder while reading — the file reaches multiple megabytes and parsing it would otherwise block a frame. The read takes no lock and never writes, so browsing cannot disturb a concurrent recording. Repeats collapse because the raw log is dominated by them (one real file held 20347 rows for 10676 distinct prompts).

`config` accepts plain bytes or a unit suffix (`20mb`, `512 KB`, `1048576`) and rejects anything that is not a positive whole number of bytes.

## Activation gate

Recording, backfill, and injection run only when all three hold:

- `MIXCODE` is set and not `0`/`false`/`off` — excludes upstream `pi`, which also loads this package;
- `MIXCODE_PID` equals this process's pid — excludes child processes that merely inherited the env;
- `ctx.mode === "tui"` — excludes in-process subagent sessions, which are created without a mode and therefore report `"print"`. Their `input` events also report `source: "interactive"`, so the source filter alone cannot exclude them.

`/prompt-history` is always available, gate or no gate.

Subagent prompts are never recorded. A subagent can still *see* the pointer text when its framework composes the child system prompt from the parent's — that is the framework's inheritance, not an injection by this package.

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

Missing file or missing `maxBytes` uses the default. Everything else fails loud rather than reverting to the default: invalid JSON, a non-object root, an unknown key, or a `maxBytes` that is not a positive integer all throw, and the message names the offending file.

This config is not part of `mixcode_settings.json` and does not appear in `/settings` — same convention as `mpi-tool-block.json`. Edit the file directly.

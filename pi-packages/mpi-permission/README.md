# mpi-permission

Gate tool calls with `allow` / `ask` / `deny` rules. Every `tool_call` is evaluated against layered wildcard rules; `ask` opens an approval dialog, `deny` blocks the call with the matched rule in the reason.

The rule semantics (allow/ask/deny actions, per-tool wildcard rule objects, last-match-wins, ask approvals) are modeled on [opencode's permission configuration](https://opencode.ai/docs/permissions/), adapted to Pi tool names and MixCode's config layers.

[中文文档](README.zh.md)

## Skill

`$mpi-permission` or `/skill:mpi-permission` writes a policy file. It stays out of the system prompt (`disable-model-invocation`). Pi loads `pi.skills` on a normal package install. MixCode installs the built-in under `<agentDir>/extensions/`; `index.ts` contributes the same `skills/` tree through `resources_discover`. `$` completion scans that tree. Package skills are not copied into `<agentDir>/skills`.

Cookbook: [skills/mpi-permission/SKILL.md](skills/mpi-permission/SKILL.md).

## Config

| Layer | File | Notes |
|-------|------|-------|
| Global | `<agentDir>/mpi-permission.json` (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) | Always applied when present. |
| Project | `<cwd>/.pi/mpi-permission.json` (directory name follows the distribution's `CONFIG_DIR_NAME`) | Applied only when the project is trusted; ignored entirely (including parse errors) otherwise. |
| Session | in-memory | "Always allow" grants from ask dialogs plus overlay edits; dropped on restart, `/reload`, or tab close. |

Missing files are a no-op: with no config anywhere the package does not intervene at all. A config file that exists but fails to parse **fails closed**: every tool call is blocked with the file path and error until it is fixed.

Root value is an action string or an object. Keys are actual tool names (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`, any extension tool name), `*` (fallback for tools without a matching rule of their own), plus the guards `external_directory` and `doom_loop`:

```json
{
  "$schema": "extensions/mpi-permission/mpi-permission.schema.json",
  "*": "allow",
  "bash": { "*": "ask", "git *": "allow", "git push*": "deny" },
  "read": { "*": "allow", "*.env": "deny", "*.env.example": "allow" },
  "edit": { "*": "deny", "src/*": "allow" },
  "external_directory": { "*": "ask", "~/notes/**": "allow" },
  "doom_loop": "ask"
}
```

| Form | Meaning |
|------|---------|
| `"<tool>": "allow" \| "ask" \| "deny"` | One action for every call of that tool. |
| `"<tool>": { "<pattern>": action, ... }` | Pattern rules over the tool's subject; **last matching rule wins**, so put `"*"` first and specific rules after it. |
| `"doom_loop": action` | Action string only, no patterns. Semantics: [Guards](#guards). |
| `"$schema": string` | Optional editor schema reference; accepted, preserved on overlay writes, ignored by evaluation. |

The package ships `mpi-permission.schema.json` (installed to `<agentDir>/extensions/mpi-permission/mpi-permission.schema.json`) for editor completion and validation. In the global file the relative form above works as-is; in a project file use an absolute path or your editor's schema mapping.

Both config files accept `//` line comments and `/* ... */` block comments (JSONC); comments inside string values are preserved. Note the `/permission` overlay rewrites the file as plain JSON, dropping hand-written comments.

## Permission probe

The package registers a `permission_probe` tool, but keeps it inactive at session start. Enable it through Pi's existing active-tool controls when the model should use it. It accepts a target tool name and input object, validates the input against the target tool's registered parameter schema, then reports the current `allow` / `ask` / `deny` result without executing the target tool. Unknown tools return `unknown_tool`; invalid target input returns `invalid_target_input`. Probe calls do not advance the `doom_loop` counter.

```json
{
  "toolName": "read",
  "input": { "path": ".env" }
}
```

The result includes `action`, boolean `wouldAllow` / `wouldAsk` / `wouldBlock` fields, and matched permission sources. A successful probe describes what a subsequent real call would do; it does not guarantee that the target tool will succeed.

Enable it for the current session with `/permission-probe`. The command is idempotent and preserves all currently active tools. The activation is session-scoped and is not persisted.

## Matching

- `*` matches zero or more characters (including `/`), `?` matches exactly one; everything else is literal.
- A leading `~` or `$HOME` in a pattern expands to the home directory.
- Layers concatenate global → project → session; last match wins across the whole list, so later layers override earlier ones.
- Unmatched calls default to `allow`.

Per-tool subject:

| Tool | Matched against |
|------|-----------------|
| `bash` | Each AST-parsed command segment, including command/process substitutions and static nested `bash` / `sh` / `zsh` / `dash` / `ksh -c` scripts. Quotes are removed, whitespace is normalized, and leading assignments plus transparent wrappers `sudo` / `env` / `command` / `builtin` / `exec` are dropped. A compound command takes the most severe segment decision (`deny` > `ask` > `allow`). |
| `read` / `edit` / `write` / `ls` | Absolute file path. Relative patterns match both the cwd-relative and absolute forms, so `*.env`, `src/*`, and `/abs/*` all work. |
| `grep` / `find` | The search `pattern` input. |
| any other tool | `JSON.stringify(input)`; string-form rules (`"tool": "deny"`) always apply. |

## Guards

### `external_directory`

When a path-taking tool (`read` / `edit` / `write` / `ls`, and `grep` / `find` with a `path` input) resolves outside the working directory, the path is also evaluated against the `external_directory` rules. Bash AST scanning applies the same guard to static path arguments of common file commands (`cd`, `ls`, `cat`, `rm`, `cp`, `mv`, `mkdir`, `touch`, `chmod`, `chown`, `find`, and related inspection commands), redirection targets, command/process substitutions, and static nested shell scripts. Existing path ancestors are realpathed before containment is checked, so an in-project symlink cannot hide an external target; missing trailing segments are supported. Multiple ask decisions from one command are combined into one dialog.

The final decision is the most severe tool or guard action (`deny` > `ask` > `allow`). No rules under `external_directory` means the guard is off; use `"*": "ask"` to gate every detected external path. A trailing slash is equivalent to the same path without it, so `"../"` matches the parent directory itself while `"../*"` matches content under it.

### `doom_loop`

Breaks agent retry loops: when the same tool is called with byte-identical input (compared as `JSON.stringify(input)`) 3 times **in a row**, the configured action applies to the 3rd and every further consecutive repeat.

- The streak is consecutive-only: a call with a different tool or different input resets it to 1. Approving a prompt does **not** reset it — the 4th identical call triggers again.
- The guard is independent of tool rules and combines by severity (`deny` > `ask` > `allow`), so an `allow` tool rule — including a session "Always allow" grant — does not silence it. To turn it off, remove the key or set `"doom_loop": "allow"` in a later layer (session overrides project overrides global).
- Its `ask` dialog offers only Allow once / Reject; an "always" grant would defeat the guard.
- The counter is in-memory per MixCode tab and starts with the first call made after the guard is configured.

With `"doom_loop": "ask"`:

```text
bash: echo same    #1 runs
bash: echo same    #2 runs
bash: echo same    #3 dialog "repeated with identical input"
bash: echo same    #4 dialog again (streak continues)
bash: echo other   streak resets; the next `echo same` counts as #1
```

## Ask dialog

| Choice | Effect |
|--------|--------|
| Allow once | This call only. |
| Always allow: `key[pattern]` | Appends session-layer allow rules and proceeds. A single decision names its rule; combined decisions show the rule count. Bash suggests the first one or two command words plus `*`; paths grant the exact subject. An existing external directory grants both `<directory>` and `<directory>/*`; a file or missing path grants `<parent>/*`. |
| Reject / Esc | Blocks the call with a `rejected by user` reason. |

Without an interactive UI (`-p` / JSON mode, subagents), `ask` blocks with an explicit reason — approvals require a UI.

While the dialog is open the command has **not** started: the process spawns only after approval, and a bash `timeout` starts counting from the spawn, not from the dialog. The tool row's elapsed display and the final `Took …` both start at `tool_execution_start` (before approval), so they include the time you spend deciding; the working row shows `waiting for permission approval…` during that wait.

## Command

`/permission` — settings-style overlay over the three layers.

```text
┌─ Permission ───────────────────────────────────┐
│  /home/user/.pi/agent/mpi-permission.json          │
│  › Layer                           Global      │
│    doom_loop                       Off         │
│      same tool + identical input 3×…          │
│   bash ───────────────────────────────────     │
│    *                               ask         │
│    git *                           allow       │
│  ↑↓ select  ⏎ cycle allow/ask/deny  n new  d   │
└────────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| Enter / Space | Cycle Layer (Global → Project → Session), cycle a rule's action, or cycle `doom_loop` (Off → ask → deny → allow → Off). |
| `n` | New-rule wizard, three steps: **1/3 key** — pick from the candidate list (`*`, `external_directory`, registered tool names; type to filter, ↑↓ to pick, Enter accepts the highlighted candidate or your free text); **2/3 pattern** — prefilled `*`, per-key examples shown; **3/3 action** — choose allow / ask / deny with Space/←→, Enter adds the rule. Esc steps back one step. |
| `d` | Delete the selected rule (a key with no rules left disappears) or reset `doom_loop` to Off. |
| Esc | Cancel the input line, or close. |

Global and Project edits persist to their files immediately; Project edits are rejected while the project is untrusted. Session edits stay in memory.

## Limits

- No per-subagent rule sets; subagent sessions load the same config files and, having no UI, treat `ask` as block.
- Bash path scanning is static permission preflight, not an OS sandbox. It cannot infer filesystem access performed inside arbitrary programs (for example `python -c 'open("../x")'`), aliases/functions defined at runtime, or unresolved variable values. Use restrictive Bash rules for commands whose internal IO is not visible in the shell AST.
- Bash parsing uses the vendored [`unbash` 4.0.10](https://github.com/webpro-nl/unbash) ESM runtime under its ISC license (`vendor/UNBASH-LICENSE`).
- Bash rule matching sees the normalized AST token form (quotes removed), so patterns match `git commit -m a b`, not the original quoting.
- Session "always" grants are not persisted; re-approve or add a global/project rule to keep them.

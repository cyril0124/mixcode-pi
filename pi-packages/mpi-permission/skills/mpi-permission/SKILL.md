---
name: mpi-permission
description: Use to configure mpi-permission.json tool permissions.
disable-model-invocation: true
---

# Write mpi-permission.json

Write a valid `mpi-permission.json`.

Ask before writing when the policy is underspecified: global vs project, which tools, allow vs ask vs deny, which paths or commands.

## 1. Pick the file

| Layer | Path | When |
|-------|------|------|
| Global | `$PI_CODING_AGENT_DIR/mpi-permission.json` (default `~/.pi/agent/mpi-permission.json`) | All workdirs |
| Project | `<cwd>/.pi/mpi-permission.json` | This workdir, trusted projects only |

If the file exists, read it and edit in place. Keep unrelated keys.

Session rules live in memory (`/permission` overlay and "Always allow"). There is no session JSON file.

## 2. Fail closed

A file that exists but is invalid JSON or an invalid shape **blocks every tool call** until it is fixed. After writing, the bytes must parse. The next agent turn reloads via `before_agent_start`. This turn still uses the cached config, so the new file is not live yet.

## 3. Shape

Root is `"allow"` / `"ask"` / `"deny"`, or an object.

| Form | Meaning |
|------|---------|
| `"<tool>": "allow" \| "ask" \| "deny"` | One action for every call of that tool |
| `"<tool>": { "<pattern>": action, ... }` | Pattern rules; **last matching rule wins**. Put `"*"` first, specific rules after |
| `"$schema": string` | Editor schema ref. Ignored at eval |

Keys: real tool names (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`, any extension tool), `*` (fallback when the tool has no matching rule of its own), `external_directory`.

The root key `doom_loop` is invalid here. Configure repeated-call protection in global [mpi-stuck-guard.json](../../../mpi-stuck-guard/README.md#doom-loop).

`$schema` for the global file:

```text
extensions/mpi-permission/mpi-permission.schema.json
```

For a project file, use an absolute path to that schema, or omit `$schema`.

For a custom deny message, use `{ "action": "deny", "message": "Ask the user to push manually." }` as the pattern value. A `"*"` pattern applies the message to every call of that tool. See [Denial messages](../../README.md#denial-messages).

## 4. Matching

- `*` = any chars (including `/`), `?` = one char, else literal.
- Leading `~` or `$HOME` in a pattern expands to home.
- Layers concatenate global → project → session. Last match wins across the whole list.
- Unmatched calls default to `allow`. Missing files are a no-op. The package does not intervene.

Per-tool subject:

| Tool | Matched against |
|------|-----------------|
| `bash` | Each AST-parsed command segment (quotes stripped, whitespace normalized, `sudo`/`env`/`command`/`builtin`/`exec` dropped). A compound command takes the most severe segment (`deny` > `ask` > `allow`). |
| `read` / `edit` / `write` / `ls` | Absolute path. Relative patterns match cwd-relative and absolute forms. |
| `grep` / `find` | The search `pattern` input. |
| any other tool | `JSON.stringify(input)`. String-form rules still apply. |

### `external_directory`

When a path-taking tool resolves outside cwd, also evaluate `external_directory` rules. Bash static path args of common file commands (`cd`, `ls`, `cat`, `rm`, `cp`, `mv`, `mkdir`, and related) are scanned too. Combine by severity. No rules under this key means the guard is off. `"*": "ask"` gates every detected external path. `"../"` matches the parent directory. `"../*"` matches content under it.

## Permission probe

Enable `permission_probe` for the current session with `/permission-probe`. It validates the target input and predicts this package's permission decision without executing the target. Other extensions can still block probe calls or the target call. Activation and output details: [Permission probe](../../README.md#permission-probe).

## 5. Templates

Start from a template that matches the policy, then edit. Put `"*"` first in each pattern object.

Default-allow, deny secrets and `git push`:

```json
{
  "$schema": "extensions/mpi-permission/mpi-permission.schema.json",
  "*": "allow",
  "bash": { "*": "ask", "git *": "allow", "git push*": "deny" },
  "read": { "*": "allow", "*.env": "deny", "*.env.example": "allow" },
  "edit": { "*": "deny", "src/*": "allow" },
  "external_directory": { "*": "ask", "~/notes/**": "allow" }
}
```

Bash defaults to ask. Read-only git allowed:

```json
{
  "$schema": "extensions/mpi-permission/mpi-permission.schema.json",
  "*": "allow",
  "bash": { "*": "ask", "git status*": "allow", "git diff*": "allow", "git log*": "allow" }
}
```

Restrict `edit` / `write` to `src/`:

```json
{
  "$schema": "extensions/mpi-permission/mpi-permission.schema.json",
  "edit": { "*": "deny", "src/*": "allow" },
  "write": { "*": "deny", "src/*": "allow" }
}
```

Gate every external path:

```json
{
  "$schema": "extensions/mpi-permission/mpi-permission.schema.json",
  "external_directory": { "*": "ask" }
}
```

Write 2-space JSON with a trailing newline. The loader accepts `//` line comments and `/* */` block comments (JSONC); the `/permission` overlay rewrites the file as plain JSON, dropping hand-written comments.

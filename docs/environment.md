# Environment Variables

[中文文档](environment.zh.md)

User-facing MixCode product environment variables owned or set by `src/`.
Not listed here: `run.sh` / test / GIF tooling knobs, or upstream Pi (`PI_*`) — see Pi docs for those.

**Conventions**

- Product / host vars use the `MIXCODE` / `MIXCODE_*` prefix.
- Unless noted, “set” means a non-empty string. Boolean-style flags treat `0`, `false`, and `off` (case-insensitive) as off when the code normalizes them that way.

## Host Identity

| Variable | Set by | Meaning |
| --- | --- | --- |
| `MIXCODE` | MixCode (`src/cli/main.ts`) after it decides **not** to delegate to upstream `pi` | Process is MixCode, not bare `pi`. Built-in packages that must not activate under pure Pi should gate on this (e.g. `mpi-herdr-report`). Default when MixCode runs: `1` (`??=`, does not override an explicit value). Off when unset / empty / `0` / `false` / `off`. |

## Agent Bash Tool (Per Spawn)

Injected into the **agent bash tool** child environment only (same surface as Pi `PI_SESSION_*`). Not set on the host process; not injected into user `!` / `!!` shells.

| Variable | Set by | Meaning |
| --- | --- | --- |
| `MIXCODE_TAB_TITLE` | Bash tool spawn | Title of the tab that owns this agent (e.g. `Agent-01`). Follows renames on the next spawn. |
| `MIXCODE_FOCUSED_TAB_TITLE` | Bash tool spawn | Title of the UI-focused agent tab. Unset when focus is Home or unknown. May differ from `MIXCODE_TAB_TITLE` when a background tab runs bash. |
| `MIXCODE_PID` | Bash tool spawn | PID of the mpi host process that owns this agent. `mpi ctl` uses it as an implicit `--pid` (explicit `--pid`/`--workdir` still win). More durable than `$PPID` for detached descendants (nohup/setsid). |

## Resource Discovery & Isolation

Variables to restrict resource scanning (skills, extensions) to project/workdir or built-in scope.

| Variable | Set by | Meaning |
| --- | --- | --- |
| `MIXCODE_BUILTIN_EXTENSIONS_ONLY` | User / Environment | When enabled (`1`, `true`, `on`, `yes`), loads MixCode built-in extensions (`pi-packages/*`) only, skipping discovery of third-party/global/workspace extensions. Equivalent to `--builtin-extensions-only`. Off when unset / empty / `0` / `false` / `off` / `no`. |
| `MIXCODE_PROJECT_SKILLS_ONLY` | User / Environment | When enabled (`1`, `true`, `on`, `yes`), drops skills outside the workdir from `$` completion and the session prompt, including global user and built-in package skills. Off when unset / empty / `0` / `false` / `off` / `no`. |

### Skill Isolation Semantics (`MIXCODE_PROJECT_SKILLS_ONLY`)

By default, MixCode discovers skills from four sources in hierarchical precedence:
1. Project/workdir: `<workdir>/.agents/skills` (and `<workdir>/.pi/skills`)
2. User global: `~/.agents/skills`
3. Agent global: `<agentDir>/skills` (default `~/.pi/agent/skills`)
4. Installed packages: npm/git package `skills/` trees and built-in `<agentDir>/extensions/<package>/skills` roots contributed through `resources_discover`

When `MIXCODE_PROJECT_SKILLS_ONLY` is set to `1` / `true` / `on` / `yes`:
- **`$` completion**: `scanSkillEntries` only scans `<workdir>/.agents/skills`.
- **Session prompt**: Pi still discovers default skill roots; MixCode then drops `scope === "user"` skills and any skill whose `filePath` is outside the workdir. `<workdir>/.agents/skills` and `<workdir>/.pi/skills` remain.
- **Use Case**: Multi-repo isolation, evaluation benchmarks, or keeping global personal skills out of a project-specific prompt.

### Built-in Extensions Isolation (`MIXCODE_BUILTIN_EXTENSIONS_ONLY`)

When enabled:
- MixCode skips auto-discovering extensions in `<agentDir>/extensions/` and npm node_modules.
- Only first-party built-in packages (`pi-packages/mpi-*`) are loaded.
- Equivalent to passing the CLI flag `--builtin-extensions-only`.

## Display Overrides (UI Rendering)

Variables to override display metadata in the TUI (e.g. for screen recordings, demonstrations, or path/model masking) without modifying actual runtime models, session data, thinking levels, or filesystem paths.

| Variable | Set by | Meaning |
| --- | --- | --- |
| `MIXCODE_DISPLAY_MODEL` | User / Environment | Overrides the provider/model string shown in the bottom metadata bar (e.g. `custom-model`). |
| `MIXCODE_DISPLAY_THINKING` | User / Environment | Overrides the thinking level text shown in the bottom metadata bar (e.g. `High`, `DeepThinking`). |
| `MIXCODE_DISPLAY_WORKDIR` | User / Environment | Overrides the displayed workdir path in the bottom metadata bar and Home tab cards (e.g. `/virtual/demo`). |

## Related External Hosts

Pane multiplexers may inject their own env (e.g. `HERDR_*`). Those are defined by the host, not MixCode. Built-in packages that talk to such hosts should document required vars in the package itself and still gate MixCode-only behavior on `MIXCODE`.

## Adding a New Variable

1. Prefer `MIXCODE_*` for MixCode-owned, user-facing knobs in `src/`.
2. Document it in this file (table row + who sets it + semantics).
3. If built-in packages or pure-`pi` co-loading is affected, note the gate under **Host Identity** or the package `README` / header comment.
4. Avoid silent dual names; pick one canonical variable.
5. Do not put script-only, test-only, or upstream Pi env vars in this file.

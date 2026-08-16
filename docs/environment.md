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
| `MIXCODE_BUILTIN_EXTENSIONS_ONLY` | User / Environment | When enabled (`1`, `true`, `on`, `yes`), loads MixCode built-in extensions (`pi-packages/*`) only, skipping discovery of third-party/global/workspace extensions. Equivalent to `--builtin-extensions-only`. Off when unset / empty / `0` / `false` / `off` / `no`. |

## Agent Bash Tool (Per Spawn)

Injected into the **agent bash tool** child environment only (same surface as Pi `PI_SESSION_*`). Not set on the host process; not injected into user `!` / `!!` shells.

| Variable | Set by | Meaning |
| --- | --- | --- |
| `MIXCODE_TAB_TITLE` | Bash tool spawn | Title of the tab that owns this agent (e.g. `Agent-01`). Follows renames on the next spawn. |
| `MIXCODE_FOCUSED_TAB_TITLE` | Bash tool spawn | Title of the UI-focused agent tab. Unset when focus is Home/config or unknown. May differ from `MIXCODE_TAB_TITLE` when a background tab runs bash. |

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

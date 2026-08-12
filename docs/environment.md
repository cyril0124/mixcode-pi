# Environment variables

User-facing MixCode product env owned or set by `src/`.
Not listed here: `run.sh` / test / GIF tooling knobs, or upstream Pi (`PI_*`) — see Pi docs for those.

**Conventions**

- Product / host vars use the `MIXCODE` / `MIXCODE_*` prefix.
- Unless noted, “set” means a non-empty string. Boolean-style flags treat `0`, `false`, and `off` (case-insensitive) as off when the code normalizes them that way.

## Host identity

| Variable | Set by | Meaning |
| --- | --- | --- |
| `MIXCODE` | MixCode (`src/cli/main.ts`) after it decides **not** to delegate to upstream `pi` | Process is MixCode, not bare `pi`. Built-in packages that must not activate under pure Pi should gate on this (e.g. `mpi-herdr-report`). Default when MixCode runs: `1` (`??=`, does not override an explicit value). Off when unset / empty / `0` / `false` / `off`. |

## Related external hosts

Pane multiplexers may inject their own env (e.g. `HERDR_*`). Those are defined by the host, not MixCode. Built-in packages that talk to such hosts should document required vars in the package itself and still gate MixCode-only behavior on `MIXCODE`.

## Adding a new variable

1. Prefer `MIXCODE_*` for MixCode-owned, user-facing knobs in `src/`.
2. Document it in this file (table row + who sets it + semantics).
3. If built-in packages or pure-`pi` co-loading is affected, note the gate under **Host identity** or the package `README` / header comment.
4. Avoid silent dual names; pick one canonical variable.
5. Do not put script-only, test-only, or upstream Pi env vars in this file.

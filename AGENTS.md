# AGENTS.md

## TUI Validation

- For TUI work, code inspection and unit tests are not sufficient evidence. Run the TUI interactively, capture screenshots, and verify core keyboard flows before claiming the UI works.
- When you need to actually launch mixcode-pi to test it, use tmux. Prefer an isolated socket via `tmux -L <label>` (e.g. `tmux -L mixcode-test`) so your sessions never collide with unrelated ones. On an isolated socket, `tmux -L <label> kill-server` is safe. Otherwise, on the default socket, do not run `tmux kill-server` (it would kill unrelated sessions); kill only the specific tmux session/window you created.

## Pi Integration

-  Do not use OpenCode configuration or UI concepts as product logic unless explicitly requested. Model configuration should use Pi-native configuration sources.
- Before implementing any feature, first check whether the Pi SDK provides native support for it. The Pi SDK means Pi's official runtime, extension, package, tool, command, UI, and TUI APIs documented at https://pi.dev/docs/latest/sdk and https://pi.dev/docs/latest/tui; prefer those native capabilities when available instead of rebuilding equivalent functionality.

## Built-in Extensions

- Built-in Pi extensions live in `pi-packages/<name>/`. Each package has a `package.json` with a `pi.extensions` field and an `index.ts` default-exporting an `ExtensionFactory`.
- Name first-party packages with the `mpi-` prefix (directory, `package.json` name, and `binary-entry.ts` `builtinPackages` key must all match, e.g. `mpi-skill-refs`). Vendored upstream packages (e.g. `rpiv-todo`) keep their original name. Do not prefix runtime protocol strings such as command names, `customType`, or keymap actions.
- At startup, `ensurePackageExtensions` (in `src/core/ensure-package-extensions.ts`) copies all valid packages to the effective agent dir's `extensions/` (`<agentDir>/extensions/`, where `agentDir` follows `MIXCODE_CODING_AGENT_DIR` → `PI_CODING_AGENT_DIR` → default `~/.pi/agent`), making them discoverable by Pi's file-system loader — including subagent sessions.
- For the compiled binary, `binary-entry.ts` embeds each package's files via `import ... with { type: "text" }` and passes them as `builtinPackages` to `materializeBinaryRuntimeAssets`, which writes them to `runtimeDir/packages/` before `ensurePackageExtensions` runs.
- To add a new built-in extension: create `pi-packages/mpi-<name>/package.json` + `index.ts`, then add the corresponding text imports in `binary-entry.ts`.

## Slash Commands

- Slash commands are registered in `LOCAL_COMMANDS` (`src/core/commands.ts`); their `description` is shown in the command palette and slash autocomplete.
- Persistence has three tiers: global (Pi's `<agentDir>/settings.json`, survives restart, shared across workdirs and with Pi), workdir (`mixcode_state.json`, per-workdir), and session (in-memory or `applyOverrides`, dropped on reload/restart).
- Any command that persists to Pi's global `settings.json` (survives restart, shared across workdirs and with Pi) MUST prefix its `description` with `[global]`, so users can see the global-persistence effect before running it. Example: `/hide-thinking`.
- Do not add the `[global]` prefix to workdir-level or session-level commands; the absence of a prefix means the command is not a globally-persisted setting.

## Code Quality

- Follow a TDD flow for behavior changes and bug fixes: first add or update a focused test that reproduces the expected behavior or failure, confirm it fails when feasible, then implement the smallest code change that makes the test pass.
- Every TypeScript source file must not exceed 700 lines. If it exceeds, split it into smaller focused modules before adding more code.
- Add concise English comments in TypeScript source files for non-obvious intent: invariants, side effects, ordering constraints, edge cases, and rationale for surprising decisions. Do not comment self-evident syntax or restate the code; add them when modifying an uncommented complex area as well.
- Coverage gates should preserve high signal: keep lines/statements/functions at 95%, keep global branch coverage at 90%, and prefer targeted tests for meaningful behavior over tests that only exercise incidental defensive branches.
- For TypeScript code changes, run `./test-all.sh` (parallel: typecheck, build, lint, package tests) before finishing. Fallback to sequential `npm run check` if parallel execution has issues. Use `npm run format` or `./format.sh` only when formatting is intentionally requested or scoped, and do not claim formatting was run unless the command succeeds.
- Keep formatting changes intentional and scoped. Do not mix broad reformatting with behavioral changes unless the formatter requires it.

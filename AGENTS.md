# AGENTS.md

## TUI Validation

- For TUI work, code inspection and unit tests are not sufficient evidence. Run the TUI interactively, capture screenshots, and verify core keyboard flows before claiming the UI works.
- When you need to actually launch mixcode-pi to test it, use tmux. Prefer an isolated socket via `tmux -L <label>` (e.g. `tmux -L mixcode-test`) so your sessions never collide with unrelated ones. On an isolated socket, `tmux -L <label> kill-server` is safe. Otherwise, on the default socket, do not run `tmux kill-server` (it would kill unrelated sessions); kill only the specific tmux session/window you created.

## Pi Integration

-  Do not use OpenCode configuration or UI concepts as product logic unless explicitly requested. Model configuration should use Pi-native configuration sources.
- Before implementing any feature, first check whether the Pi SDK provides native support for it. The Pi SDK means Pi's official runtime, extension, package, tool, command, UI, and TUI APIs documented at https://pi.dev/docs/latest/sdk and https://pi.dev/docs/latest/tui; prefer those native capabilities when available instead of rebuilding equivalent functionality.

## Built-in Extensions

- Built-in Pi extensions live in `pi-packages/<name>/`. Each package has a `package.json` with a `pi.extensions` field and an `index.ts` default-exporting an `ExtensionFactory`.
- Name first-party packages with the `mpi-` prefix (directory, `package.json` name, and `binary-entry.ts` `builtinPackages` key must all match, e.g. `mpi-skill-refs`). Vendored upstream packages keep their original name. Do not prefix runtime protocol strings such as command names, `customType`, or keymap actions.
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
- Prefer TypeScript source files under 1000 lines; split into focused modules when a file grows mainly by unrelated concerns. The limit is a guideline, not a hard block — a coherent file may exceed 1000 lines when splitting would only hurt clarity.
- Split on real seams only: a boundary that is independently testable, has a single clear responsibility, or is a replaceable interface. File length alone is not a seam. Prefer putting new code in the existing neighbor module; prefer merging thin single-caller satellites over further splits.
- Add concise English comments in TypeScript source files for non-obvious intent: invariants, side effects, ordering constraints, edge cases, and rationale for surprising decisions. Do not comment self-evident syntax or restate the code; add them when modifying an uncommented complex area as well.
- Before finishing TypeScript behavior changes, follow **Test Guidelines** (focused test first, then the narrowest gate that covers the touch surface). Use `bun run format` only when formatting is intentionally requested or scoped, and do not claim formatting was run unless the command succeeds.
- Keep formatting changes intentional and scoped. Do not mix broad reformatting with behavioral changes unless the formatter requires it.

## Commands

- Install deps with `bun install` (not npm). Unique lockfile: `bun.lock`.
- NEVER commit unless asked.

## Test Guidelines

Test the contract the system exposes — not the easiest internal detail to assert.

### What to write

- Every new test must defend one **concrete, externally observable contract**: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.
- Prefer contract-level tests over implementation details. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail.
- One behavior / invariant / transition per test. For lifecycle code, do not split one transition into many field-only tests.
- Error handling: trigger the real failure path and assert the surfaced contract — do not instantiate error classes just to inspect internal metadata.
- Assert exact strings, ordering, and formatting only when downstream code parses or depends on the exact bytes. Otherwise assert semantic content.
- Compile-time guarantees → type checks / type tests, not runtime placeholders.
- Prefer focused package-local or single-file verification for the changed area. Do not add tests for tiny low-risk changes unless they protect a real contract or a regression-prone edge.

### Banned

- No placeholder, tautology, or theater tests: `expect(true).toBe(true)`, bare `not.toThrow()`, non-empty / length-grew checks, "prompt exists" without semantic assertion, or expected values recomputed by calling the code under test itself.
- No mock theater: never mock the code under test; mock only true external boundaries (network, paid providers, OS sandbox). Prefer real objects, tmpdirs, and existing test helpers (`test/helpers/`).
- Don't duplicate coverage across abstraction levels. If an integration test already proves the behavior, drop the narrower unit test that restates it through mocks.
- Smoke tests only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- **Never source-grep.** A test that reads an implementation file (`.ts`/`.rs`/build script) and asserts on its *text* — `expect(src).toContain("someCall()")`, `.toMatch(/import .../)`, `.not.toContain("oldName")`, or "comment must say X" — is banned. It tests how code *looks*, not what it *does*. Assert the observable contract instead (run the code, check output/state/error); enforce structural invariants with a type test or lint/biome rule — never a string scan of the source. (Reading a file your code *wrote* — apply-patch result, generated bundle, temp fixture — is fine; that is behavior.)
- Do not delete, skip, or weaken a failing test to go green unless the user explicitly authorizes it.
- Do not claim tests pass from stale output, assumption, or code inspection alone — re-run and use this run's result.

### How to run

- Runner: Node built-in `node:test` + `tsx` (not vitest/jest). Root tests live in flat `test/*.test.ts`; package tests are colocated as `pi-packages/*/*.test.ts`.
- Focused (default while iterating):
  - `node --test --import tsx test/<file>.test.ts`
  - `node --test --import tsx pi-packages/<pkg>/<file>.test.ts`
- Package tests: `bun run test:packages`
- Root suite: `bun run test` (`test/*.test.ts` only)
- Full sequential gate: `bun run check` (typecheck + build + root tests)
- Parallel package-oriented gate: `./test-all.sh` (typecheck + build + lint + package tests; does **not** run full `test/*.test.ts`)
- Package manager: Bun only — install with `bun install`; lockfile is `bun.lock` (do not commit `package-lock.json`). Node remains required for `node --test` / `tsx` and for running `dist/` via `run.sh`.
- `postinstall` runs `patch-package` only. pi-tui keybindings bridge supports both single-instance (bun/npm dedupe) and dual-instance (npm shrinkwrap nested) layouts without layout scripts.
- When running backend unit tests, enforce a hard timeout of 60 seconds to avoid stuck tasks.
- TUI/UI claims still require interactive proof per **TUI Validation**; unit tests alone are not enough. Optional automated smoke: `MIXCODE_RUN_TMUX_TUI_SMOKE=1` with `test/tui-smoke.test.ts`.
- Before finishing a TypeScript behavior change: run the focused test(s) you added or changed until green, then the narrowest gate that covers the touch surface (`test:packages` for package work, `bun run check` and/or `./test-all.sh` as appropriate). Fix until green.

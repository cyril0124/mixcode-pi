# AGENTS.md

## Conversational Style

- Use concise, direct technical prose. No emojis in responses, PR comments, or code.
- Answer questions before edits or implementation commands. For feedback or analysis, state agreement or disagreement before describing changes.
- `Agent` subagents must inherit or explicitly use the session model (`PI_MODEL`). Prefer `run_in_background: true`; continue independent work or respond without polling or idling.

## Documentation Standards

- Before writing, reorganizing, reviewing, or trimming repository docs, read `.agents/skills/doc-standards/SKILL.md`.
- Proactively document design decisions, architecture, workflows, API contracts, and usage. Give each fact, rule, and schema one authoritative home; link instead of duplicating.
- All docs except skill instructions require synchronized English (`<name>.md`) and Chinese (`<name>.zh.md`) versions. Skill instructions live only in `SKILL.md`, never `SKILL.zh.md`.
- Extension docs belong in `pi-packages/<name>/README.md` and `README.zh.md`, not standalone `docs/` topics. Core architecture, runtime specifications, and product workflows belong in `docs/`.
- Describe current behavior with exact paths, flags, types, errors, and invariant boundaries. History belongs in commits and PR notes.
- Comments, JSDoc, and docs describe complete caller/callee contracts (inputs, side effects, throws, concurrency, ownership), not code walkthroughs. Update affected docs/JSDoc with public behavior, config, or command changes; delete obsolete docs with obsolete code.
- Changes to `mpi status`, `mpi ctl`, or their env contracts (`MIXCODE`, `MIXCODE_PID`, `MIXCODE_TAB_TITLE`, `MIXCODE_FOCUSED_TAB_TITLE`) must update `pi-packages/mpi-ctl-skill/skills/mpi-ctl/SKILL.md`; update its README pair when the package description changes.
- Batch API changes must synchronize executors (`src/core/batch-lua.ts`: `.lua`; `src/core/batch-ts.ts`: `.ts`/`.mts`/`.js`/`.mjs`), stubs in `pi-packages/mpi-batch-skill/skills/mpi-batch/references/` (`mixcode-batch.d.lua`: snake_case; `mixcode-batch.d.ts`: camelCase globals), and `docs/batch-scripts.md` + `.zh.md`. The root stub paths are relative symlinks to these files; keep one copy of each definition. `test/batch-ts.test.ts` checks TS stub/runtime compatibility at compile time; check Lua stubs and docs manually. Batch API, CLI flag, or execution-semantics changes must also update the affected instructions and examples in `pi-packages/mpi-batch-skill/skills/mpi-batch/SKILL.md` in the same change. Keep the skill and its references self-contained. `examples/**/*.ts` is included in `tsconfig.json` and must pass `bun run typecheck`.

## TUI & E2E Validation

- Use isolated tmux validation for real terminal interaction or runtime lifecycle behavior not covered by automated tests. Failure to reproduce does not disprove a reported bug.
- Launch mixcode-pi tests in tmux, preferably `tmux -L <label>`. `kill-server` is safe only on an isolated socket; on the default socket, kill only the session/window you created.
- Read-only pagers, log/content viewers, and diff views in `src/` and `pi-packages/` support arrows plus `j`/`k` (line), `Ctrl+D`/`Ctrl+U` (half page), `g`/`G` (top/bottom), `q` (close). References: `handleVimModeKey` in `src/ui/app-key-handlers.ts` and `pi-packages/mpi-diff-viewer/diff-viewer.ts`.
- Query-input surfaces (command palette, `/models`, `/workdir`, extension manager, workspace overlay) are excluded: printable characters enter search text; bound `Ctrl+U` clears the query.
- Hints list actual bindings. Under width pressure, drop middle hints first, retaining scroll/close. Destructive actions on read-only surfaces require inline confirmation replacing the hints: only `y` confirms; every other key, including `q`/`Esc`, cancels.

## Pi Integration

- Before implementing features or inventing local APIs/UI, check installed `@earendil-works/pi-*` packages and the references below. Reuse upstream selectors, editors, dialogs, markdown, keybindings, session/tree UI, etc. Implement locally only for unmet requirements or explicitly requested different behavior.
- Prefer a clean upstream export patch in `patches/` for existing private/unexported components over a local duplicate. Keep `src/` events, themes, and runtime hooks aligned with Pi conventions.
- Core uses public Pi APIs only (`clearQueue`, `steer`, `followUp`); never invoke or patch private `AgentSession` members such as `_handlePostAgentRun` or `_steeringMessages`.
- Core fixes must be generic and Pi SDK protocol-compliant, without exceptions for named third-party extensions. Domain features (compaction, prompt optimization, external session reporting) belong in independent `pi-packages/mpi-<name>` packages, not `src/`.
- The pi-tui keybindings bridge supports single-instance (bun/npm dedupe) and dual-instance (npm shrinkwrap nested) layouts without layout scripts.

References:

| Subject | Source |
| --- | --- |
| Upstream SDK / TUI / packages | https://pi.dev/docs/latest/sdk / https://pi.dev/docs/latest/tui / https://pi.dev/packages |
| MixCode/Pi compatibility | `docs/extension-compatibility.md` |
| Local architecture, not upstream API authority | `docs/architecture.md` |
| Local TUI chrome, overlays, transient components | `docs/tui-components.md` |
| User-facing `src/` environment knobs | `docs/environment.md`; exclude upstream `PI_*` and `run.sh`/test/GIF tooling envs |

## Built-in Extensions

- Packages live in `pi-packages/<name>/` with a `package.json` `pi` field. Runtime packages declare `pi.extensions` and default-export an `ExtensionFactory`. Packages with `pi.skills` expose their installed `skills/` root through public `resources_discover`, since built-ins use `<agentDir>/extensions/`, not Pi package settings.
- First-party directory, package name, and `binary-entry.ts` `builtinPackages` key must match and start with `mpi-`. Vendored packages keep upstream names. Do not prefix protocol strings (commands, `customType`, keymap actions).
- At startup, `ensurePackageExtensions` (`src/core/ensure-package-extensions.ts`) copies valid packages to `<agentDir>/extensions/`; `agentDir` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Pi discovers entries there; `resources_discover` supplies skill roots to MixCode and independent subagent ResourceLoaders. Never copy package skills to `<agentDir>/skills`.
- `binary-entry.ts` embeds package files with `import ... with { type: "text" }` and passes `builtinPackages` to `materializeBinaryRuntimeAssets`, which writes `runtimeDir/packages/` before `ensurePackageExtensions`. New built-ins require `pi-packages/mpi-<name>/package.json`, declared extension/skill resources, and matching binary text imports.
- Packages must not import or depend on one another. They run under pure upstream `pi` (Node + jiti) as well as `mpi`: use `node:*`, never `Bun.*`, `bun:*`, or Bun Shell. The Bun preferences below apply outside `pi-packages/`.
- MixCode sets `MIXCODE=1` after declining upstream delegation. Packages that must not activate under pure Pi should gate on it; unset, `0`, `false`, and `off` mean off.

### Third-party Loading in Compiled `mpi`

- Bun `--compile` + jiti `virtualModules` can fail with `Type4 is not defined` when extensions import `Type` through `@earendil-works/pi-ai`. `patches/@earendil-works%2Fpi-coding-agent@*.patch`, applied through `bun patch`/`patchedDependencies`, rebinds these virtual entries to bundled `typebox`.
- That patch's `MIXCODE_EXTENSION_SINGLE_FLIGHT` joins identical in-flight `jiti.import` calls across concurrent services builds (one per restored tab), avoiding duplicate imports/races. Clear the shared in-flight map with the extension factory cache.
- At `createRuntimeServices`, `preferDistExtensionEntries` idempotently rewrites declared `pi.extensions` entries from `./src/....ts` to `./dist/....js` when dist exists. Scan only `<agentDir>/npm/node_modules`.

## Slash Commands & Settings

- Register slash commands in `LOCAL_COMMANDS` (`src/core/commands.ts`); `description` appears in the command palette and slash autocomplete.
- Persistence tiers: global (`<agentDir>/settings.json`, survives restart, shared across workdirs and Pi), workdir (`mixcode_state.json`), session (memory/`applyOverrides`, lost on reload/restart).
- Prefix descriptions with `[global]` exactly when commands persist to Pi's global settings (e.g. `/hide-thinking`); never for workdir/session settings.
- All user-facing command failures (dispatch, parsing, execution, invalid usage, export) must start with `Error:` whether thrown, system messages, or toasts, so TUI and `mpi ctl dump-screen` share a marker. Examples: `Error: Unknown model: <query>`, `Error: Usage: /<command> [yes]`. Internal invariants unreachable from user input retain bare messages (e.g. `Unknown tab session: <id>`). `showErrorOverlay` strips the prefix because its title is Error.
- All MixCode config schemas, defaults, constants (`MIXCODE_SETTINGS_FILENAME`), and validation belong in `src/core/mixcode-settings.ts`, not domain modules. Validate keys/types strictly at load; no silent defaults for invalid config.

## Code Quality

- Prefer TypeScript files under 1000 lines, but split only at independently testable, single-responsibility, or replaceable boundaries. Coherent files may exceed the guideline. Prefer neighboring modules and merging thin single-caller modules over more splits.
- Add concise comments in TypeScript for non-obvious invariants, side effects, ordering, edge cases, or surprising decisions, including when editing uncommented complex code. Do not narrate syntax.
- User misconfiguration, missing required dependencies, and schema violations must fail at load/parse time, never silently or with fake success.
- Swallow errors only for expected optional probes (e.g. initial cache/history `ENOENT`) or non-blocking teardown cleanup. Document the swallowed error type and why it is safe; limit the `try` block to one statement.
- Trust statically typed, same-process values. Strict runtime validation belongs at external boundaries: JSON, config, model outputs, files, process I/O.
- Do not mention legacy/third-party harness names (including `opencode`, `OpenCode`, `pi-continue`, `open-tui`) in source, comments, commits, or package descriptions.
- Keep formatting intentional and scoped; avoid broad formatting with behavior changes unless required by the formatter. Run `bun run format` only when intentionally requested or scoped.
- No test-only exports in `src/`, including `src/index.ts`. Exercise production call paths or compose production helpers; test-only helpers belong in `test/`.

### TypeScript Style

- Avoid `any` unless necessary; use actual library/`node_modules` types over guessed shapes.
- Use named return types directly (`RuntimeTab`); reserve `ReturnType` for anonymous/inferred shapes or third-party methods.
- Prefer `export *` in pure barrels. Resolve star ambiguity by removing redundant export paths, not named re-exports.
- Prefer top-level `import type`; reserve dynamic `import()` for lazy, optional, or binary-entry boundaries.
- Prefer `Promise.withResolvers()` for separately exposed resolve/reject. Use `new Promise` for event/callback adapters, rejectable timers, `setImmediate`, and sentinel-returning `Promise.race` timers. Pure-Node packages may wrap `setTimeout`.

## Tooling & Git

- Install only with `bun install`; use `bun.lock`, never commit npm/yarn/pnpm lockfiles. Run scripts with `bun run` and product code with Bun (`run.sh`, shebang), never Node where `Bun.*` is used.
- Prefer `fd` for file/directory discovery and `rg` for content/symbol search.
- Commit only when asked. Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).

## Bun Over Node

Outside pure-Node `pi-packages/`, prefer cleaner Bun APIs; use `node:*` where Bun lacks coverage. Never spawn shell commands for operations with proper APIs, such as directory creation.

| Operation | Prefer | Instead of |
| --- | --- | --- |
| File read/write | `Bun.file()`, `Bun.write()` | `readFileSync`, `writeFileSync` |
| Process | Bun Shell, `Bun.spawn()` | `child_process` |
| Sleep | `Bun.sleep(ms)` | `setTimeout` promise |
| Binary lookup | `Bun.which("git")` | spawning `which` |
| HTTP | `Bun.serve()` | `http.createServer()` |
| SQLite | `bun:sqlite` | `better-sqlite3` |
| Hashing | `Bun.hash()`, bcrypt `Bun.password.hash/verify`, WebCrypto | `node:crypto` |
| Paths | `import.meta.dir`, `import.meta.path` | `fileURLToPath` conversion |
| JSON5 | `Bun.JSON5.parse()` / `.stringify()` | `json5` |
| JSONL | `Bun.JSONL.parse()` / `.parseChunk()` | split/map/`JSON.parse` |
| String width | `Bun.stringWidth(text, { countAnsiEscapeCodes: false })` (option optional) | `get-east-asian-width`, custom code |
| Wrapping | `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })` | custom ANSI-aware wrappers |

### Processes, Imports & I/O

- Prefer Bun Shell for simple commands: ``import { $ } from "bun"; const result = await $`git status`.cwd(dir).quiet().nothrow();``. Check `result.exitCode`, read `result.text()`; Shell methods include `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`. Omit `await` for fire-and-forget.
- Reserve `Bun.spawn`/`Bun.spawnSync` for long-running processes (LSP/kernels), streaming I/O (SSE/JSON-RPC), or lifecycle control (signals/kill). Cast piped streams as `ReadableStream<Uint8Array>` before `.getReader()`.
- Always namespace-import `node:fs`, `node:path`, and `node:os` (`import * as fs from "node:fs/promises"`). Async-only files use `node:fs/promises`; mixed sync/async files use `node:fs` and `fs.promises.xxx`.
- Read via `await Bun.file(path).text()`/`.json()` and write via `await Bun.write(path, data)`, which creates parent dirs. Use `node:fs/promises` for directory operations (`mkdir`, `rm`, `readdir`). Sync I/O is only for synchronous interfaces, not async flows.
- Read directly and catch `ENOENT` for missing files; rethrow other errors. Avoid existence checks before reads, duplicate `Bun.file(path)` handles across helpers, and `mkdir` before `Bun.write`. For buffers use `await fs.readFile(path)`, not `Buffer.from(await Bun.file(path).arrayBuffer())`.
- Centralize stream-reading and line-iteration helpers instead of copying reader loops. Manual loops are only for protocols that require them (SSE, streaming JSON-RPC).

## Test Guidelines

### Contracts & Coverage

- Test one contract per case: behavior, output shape, invariant/state transition, error mapping, or parsing boundary. Keep lifecycle transitions whole rather than splitting field assertions.
- Internal details (helper wiring, field assignments, singleton identity, incidental order, prompt boilerplate, option forwarding) warrant assertions only when another component depends on them. Assert exact bytes/order/format only when downstream parsing or behavior requires them; otherwise assert semantics.
- Trigger real failure paths and assert surfaced errors, not instantiated error metadata. Use type checks/type tests for compile-time guarantees.
- For meaningful behavior changes/fixes, write a focused failing test before the smallest fix.
- Mock only external boundaries (network, paid providers, OS sandbox), never the code under test. Prefer real objects, tmpdirs, and `test/helpers/`. Drop redundant mock unit coverage when integration tests already prove the contract.
- Ban placeholders, tautologies, bare `not.toThrow()`, non-empty/length-grew checks, prompt-existence assertions without semantics, and expectations recomputed by the code under test. Smoke tests must catch failures narrower tests miss; boot/start alone is insufficient.
- Never assert implementation source text (`.ts`, `.rs`, build scripts), imports, calls, names, or comments. Test behavior; use type tests or lint/Biome for structural invariants. Reading generated outputs/fixtures is valid behavioral testing.
- Never delete, skip, or weaken failing tests without explicit authorization. Test-pass claims require a fresh run.
- Default to focused package/file checks and report the checks run.

### Test Commands

- Runner: `bun test --isolate --timeout=60000`. Bun supports `node:test`-style tests and `Bun.*`; `--isolate` prevents cross-file nesting bugs. Root tests: flat `test/*.test.ts`; package tests: `pi-packages/*/*.test.ts`.
- Focused: `bun test --isolate --timeout=60000 test/<file>.test.ts` or `bun test --isolate --timeout=60000 pi-packages/<pkg>/<file>.test.ts`.
- Changed-only: `bun run test:changed` traces reverse imports from unstaged, staged, and untracked changes to affected tests; `bun run test:changed --changed=main` compares a base. The script adds root-suite `--parallel` because `--changed` alone is serial.
- Packages: `bun run test:packages`. Root suite: `bun run test`, only `test/*.test.ts`, with `--parallel=min(16, cores)` to avoid starving timing-sensitive tests. `--timings`/`--update-timings` read/write gitignored `.test-timings.json` to run slow files first; a missing file is created on the next run.
- Sequential gate: `bun run check` (typecheck, build, root tests). Parallel package gate: `./test-all.sh` runs `bun run --parallel --no-exit-on-error typecheck build lint test:packages`, not root tests; all jobs finish and the script returns the first failing job's code.

### Dependencies & Commit Gate

- Compare dependencies with `bun pm diff <pkg>` (locked to latest) or `bun pm diff <pkg>@<from> <to> [paths...]`. It reports changed files, install scripts, and new `child_process`/`fs`/`net`/`vm` imports before an un-minified diff, skipping formatting-only changes. Scope to patched paths to assess rebasing; see `.agents/skills/pi-packages-upgrade/SKILL.md`.
- `bun install` applies `patchedDependencies` from `patches/`. Edit patches with `bun patch <pkg>`, modify `node_modules`, then `bun patch --commit <pkg>`.
- `postinstall` only runs `bun run scripts/install-pi-extensions.ts --postinstall`: optional interactive installation of missing recommended third-party Pi packages on TTY; warnings only on CI/non-TTY; never fails the parent install. Manual entry points: `bun run install:extensions`, `./install-pi-extensions.sh`.
- Opt-in per-clone commit gate: `prek install` or `pre-commit install`. `.pre-commit-config.yaml` runs whole-repo `bun run format` then `bun run lint` (`pass_filenames: false`); lint matches CI, formatting is hook-only. Without installation, commits are ungated.
- The hook stashes unstaged changes; gate failure leaves the worktree untouched. Formatting may rewrite files while exiting 0; pre-commit then fails with "files were modified by this hook". Re-stage formatted files and commit again.

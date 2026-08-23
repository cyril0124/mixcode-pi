# AGENTS.md

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Conversational Style
- Keep answers short and concise
- No emojis in responses, PR comments, or code
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.
- When spawning subagents via `Agent` or `TaskExecute`, always inherit or explicitly specify the same model as the current session (`PI_MODEL`). Prefer background execution (`run_in_background: true`) to avoid blocking interactive conversation, and continue with independent foreground tasks or respond to the user without polling or idling.
- For any potentially long-running operations (builds, dev servers, watchers, long-running test suites, interactive servers), always use the `process` tool to run them as background processes instead of blocking the foreground shell.

## Documentation Standards

- Before writing, reorganizing, reviewing, or trimming repository documentation, read and follow `.agents/skills/doc-standards/SKILL.md`.
- **Proactive Documentation**: Actively document design decisions, architecture, workflows, API contracts, and usage patterns across the repository.
- **Bilingual Documentation Pairing (EN / ZH)**:
  - All documentation must be provided in both English and Chinese.
  - English documents use standard names (e.g., `README.md`, `docs/architecture.md`, `<topic>.md`).
  - Chinese documents use the `.zh.md` suffix (e.g., `README.zh.md`, `docs/architecture.zh.md`, `<topic>.zh.md`).
  - Keep both language versions synchronized whenever documentation is created or updated.
- **One Home Per Fact**: Every concept, architectural rule, or configuration schema has exactly one authoritative owner. Link across documents rather than duplicating text.
- **Extension Documentation Isolation**: Dedicated extension documentation must live in the package's own directory (`pi-packages/<name>/README.md` and `README.zh.md`), never scattered as stand-alone topics in `docs/`. High-level core architecture, system runtime specifications, and product workflows remain in `docs/`.
- **Present State, Not Historical Narrative**: Describe the system's current reality. Never write historical narratives ("previously", "now we support", "no longer") in technical docs; place change history in commits and PR notes.
- **Concrete Facts Over Hand-Waving**: Avoid vague abstractions. State exact paths, command flags, parameter types, error names, and invariant boundaries.
- **Contracts Over Reasoning**: Comments, JSDoc, and docs must state complete caller/callee contracts (inputs, side effects, throw conditions, concurrency, ownership), not step-by-step code narratives.
- **Change-Synchronized Documentation (Zero Drift)**: Any code change that alters public behavior, configuration keys, or commands must update affected documentation and JSDoc in the same task. Delete obsolete documentation alongside obsolete code.
- Changes to `mpi status`, `mpi ctl`, or the MixCode env contracts the `mpi-ctl` skill uses (`MIXCODE`, `MIXCODE_PID`, `MIXCODE_TAB_TITLE`, `MIXCODE_FOCUSED_TAB_TITLE`) must update `pi-packages/mpi-ctl/skills/mpi-ctl/SKILL.md` in the same task (and the package README pair if the package description changes).
- The batch script API spans five artifacts that must change together: the executors (`src/core/batch-lua.ts` for `.lua`, `src/core/batch-ts.ts` for `.ts`/`.mts`/`.js`/`.mjs`), both root stubs (`mixcode.lua` snake_case, `mixcode-batch.d.ts` camelCase globals), and the `docs/batch-scripts.md` + `.zh.md` pair. `test/batch-ts.test.ts` guards the TS stub against the runtime API at compile time; the Lua stub and the docs have no guard, so update them by hand. `examples/**/*.ts` is in `tsconfig.json` `include`, so example scripts must pass `bun run typecheck`.

## TUI & E2E Validation

- For TUI and runtime lifecycle work, code inspection, isolated unit tests, and synthetic mocks are not sufficient evidence. Bugs in session lifecycle, tab management, goal tracking, performance lag, and interactive TUI flows must be reproduced end-to-end in tmux — capture screenshots and verify core keyboard/mouse flows before claiming a bug, a fix, or working UI. If a reported issue cannot be reproduced in tmux, it is not considered a bug.
- When you need to actually launch mixcode-pi to test it, use tmux. Prefer an isolated socket via `tmux -L <label>` (e.g. `tmux -L mixcode-test`) so your sessions never collide with unrelated ones. On an isolated socket, `tmux -L <label> kill-server` is safe. Otherwise, on the default socket, do not run `tmux kill-server` (it would kill unrelated sessions); kill only the specific tmux session/window you created.
## Pi Integration

- Before implementing any feature, check whether installed `@earendil-works/pi-*` packages already provide it (docs list below). Build custom code only when they do not cover the requirement (or the user explicitly requires different behavior); do not reimplement selectors, editors, dialogs, markdown, keybindings, session/tree UI, or similar just because a local rewrite is convenient.
- If upstream Pi has implemented a feature or component but keeps it unexported/private, prefer creating a clean upstream export patch in `patches/` rather than writing a duplicate local reimplementation.
- Regularly align `src/` core event handling, themes, and runtime hooks with upstream Pi agent conventions.
- The pi-tui keybindings bridge supports both single-instance (bun/npm dedupe) and dual-instance (npm shrinkwrap nested) module layouts without layout scripts.
- Pi docs (check these before inventing local APIs or UI):
  - Upstream SDK: https://pi.dev/docs/latest/sdk
  - Upstream TUI: https://pi.dev/docs/latest/tui
  - Package catalog: https://pi.dev/packages
  - Local MixCode↔Pi compatibility: `docs/extension-compatibility.md`
  - Local architecture mapping (not upstream API source): `docs/architecture.md`
  - Local MixCode TUI component catalog (chrome / overlays / transient): `docs/tui-components.md`
  - MixCode product env (user-facing `src/` knobs only): `docs/environment.md` — do not list upstream `PI_*`, or `run.sh` / test / GIF tooling envs there

## Built-in Extensions

- Built-in Pi packages live in `pi-packages/<name>/`. Each package has a `package.json` with a `pi` field. Runtime packages declare `pi.extensions` and default-export an `ExtensionFactory`; packages with `pi.skills` also expose their installed `skills/` root through the public `resources_discover` event because MixCode installs built-ins under `<agentDir>/extensions/`, not Pi package settings.
- Name first-party packages with the `mpi-` prefix (directory, `package.json` name, and `binary-entry.ts` `builtinPackages` key must all match, e.g. `mpi-skill-refs`). Vendored upstream packages keep their original name. Do not prefix runtime protocol strings such as command names, `customType`, or keymap actions.
- At startup, `ensurePackageExtensions` (in `src/core/ensure-package-extensions.ts`) copies all valid packages to the effective agent dir's `extensions/` (`<agentDir>/extensions/`, where `agentDir` follows `PI_CODING_AGENT_DIR` → default `~/.pi/agent`). Pi discovers extension entries there; their `resources_discover` handlers contribute package skill roots to the current MixCode or independent subagent ResourceLoader. Package skills are never copied into `<agentDir>/skills`.
- For the compiled binary, `binary-entry.ts` embeds each package's files via `import ... with { type: "text" }` and passes them as `builtinPackages` to `materializeBinaryRuntimeAssets`, which writes them to `runtimeDir/packages/` before `ensurePackageExtensions` runs.
- To add a new built-in package: create `pi-packages/mpi-<name>/package.json` and its declared `pi.extensions` and/or `pi.skills` resources, then add the corresponding text imports in `binary-entry.ts`.
- **No Bun APIs in `pi-packages/`.** These packages are installed into `~/.pi/agent/extensions/` and also run under pure upstream `pi` (Node + jiti), not only under `mpi` (Bun). Use `node:*` stdlib (`fs`, `fs/promises`, `child_process`, `path`, `os`, …). Do not call `Bun.*`, `bun:*` imports, or Bun Shell (`` $`…` ``). Product code under `src/` may still prefer Bun; this rule is package-only.
- **Strict Isolation Across `pi-packages/`**: Packages under `pi-packages/` must remain completely independent and decoupled; they must NEVER import or depend on one another.
- MixCode sets `MIXCODE=1` after it decides not to delegate to upstream `pi`. Built-in packages that must not activate under pure `pi` should gate on this env (treat unset / `0` / `false` / `off` as off).

### Third-party package load (compiled `mpi`)

- Bun `--compile` + jiti `virtualModules` can break TypeBox when extensions import `Type` via `@earendil-works/pi-ai` re-exports (`Type4 is not defined`). The `patches/@earendil-works%2Fpi-coding-agent@*.patch` (`bun patch` / `patchedDependencies`) re-binds `Type` from the bundled `typebox` module for those virtual entries.
- The same patch also carries `MIXCODE_EXTENSION_SINGLE_FLIGHT`: concurrent services builds (one per restored tab at boot) join identical in-flight `jiti.import` calls instead of racing and re-importing every extension module per tab; the shared in-flight map is cleared together with the extension factory cache.
- Separately, some npm packages declare `pi.extensions: ["./src/....ts"]` while shipping a working `dist/`. At `createRuntimeServices`, `preferDistExtensionEntries` rewrites those entries under `<agentDir>/npm/node_modules` to `./dist/....js` when the dist file exists (idempotent; only that path is scanned).

## Slash Commands

- Slash commands are registered in `LOCAL_COMMANDS` (`src/core/commands.ts`); their `description` is shown in the command palette and slash autocomplete.
- Persistence has three tiers: global (Pi's `<agentDir>/settings.json`, survives restart, shared across workdirs and with Pi), workdir (`mixcode_state.json`, per-workdir), and session (in-memory or `applyOverrides`, dropped on reload/restart).
- Any command that persists to Pi's global `settings.json` MUST prefix its `description` with `[global]`, so users can see the global-persistence effect before running it. Example: `/hide-thinking`.
- Do not add the `[global]` prefix to workdir-level or session-level commands; the absence of a prefix means the command is not a globally-persisted setting.

## Settings Management

- All MixCode-specific configuration schemas, default values, file constants (`MIXCODE_SETTINGS_FILENAME`), and validation logic must reside strictly in `src/core/mixcode-settings.ts` — never scatter settings defaults or parsers across individual domain files.
- Loading configuration must strictly validate schema types and fail loud on invalid keys or types rather than silently falling back to defaults.

## Code Quality

- Testing and the finish gate: see **Test Guidelines**.
- Prefer TypeScript source files under 1000 lines; split into focused modules when a file grows mainly by unrelated concerns. The limit is a guideline, not a hard block — a coherent file may exceed 1000 lines when splitting would only hurt clarity.
- Split on real seams only: a boundary that is independently testable, has a single clear responsibility, or is a replaceable interface. File length alone is not a seam. Prefer putting new code in the existing neighbor module; prefer merging thin single-caller satellites over further splits.
- Add concise English comments in TypeScript source files for non-obvious intent: invariants, side effects, ordering constraints, edge cases, and rationale for surprising decisions. Do not comment self-evident syntax or restate the code; add them when modifying an uncommented complex area as well.
- **Fail Loud on Misconfiguration**: User configuration errors, missing required dependencies, and schema violations must fail immediately at load or parse time. Never silently swallow configuration errors or return fake success paths.
- **Public API Boundary Only**: `src/` core must rely strictly on public Pi APIs (`clearQueue`, `steer`, `followUp`). Never invoke or patch private `AgentSession` properties/methods (e.g. `_handlePostAgentRun`, `_steeringMessages`).
- **Generic Solutions Over Patchwork**: Fixes in core runtime (`src/`) must be generic and protocol-compliant with Pi SDK standards, never hardcoding special-case exceptions or hacks for specific third-party extension names.
- **Feature Isolation in Packages**: Domain-specific features (e.g. compaction strategies, prompt optimizers, external session reporters) belong in decoupled `pi-packages/mpi-<name>`, never hardcoded as core runtime logic in `src/`.
- **Banned Third-Party Names**: Do not mention legacy or third-party harness names (such as `opencode`, `OpenCode`, `pi-continue`, or `open-tui`) in source code, comments, commit messages, or package descriptions.
- **An Empty `catch` Names What It Swallows**: Allow swallowed catches strictly for expected optional probing (e.g. `ENOENT` on missing cache/history file on initial run, non-blocking cleanup during teardown). Always document the swallowed error type and why it is safe; keep the `try` block to a single statement.
- **Trust TypeScript at Typed Same-Process Boundaries**: Avoid redundant runtime type checks for statically-typed internal variables; perform strict validation only at external boundaries (JSON parsing, config files, model outputs, file system, process I/O).
- Use `bun run format` only when formatting is intentionally requested or scoped, and do not claim formatting was run unless the command succeeds.
- Keep formatting changes intentional and scoped. Do not mix broad reformatting with behavioral changes unless the formatter requires it.
- Do not add or keep `src/` exports (including via `src/index.ts` barrels) that exist only so tests can call them. Tests must exercise the real production call path or compose production helpers; if a helper is test-only, put it under `test/` — never promote it into product modules for test convenience.

### TypeScript Style

- Avoid `any` unless no practical alternative; prefer real types from libraries or `node_modules` over guessed shapes.
- When a function's return type is already a named type, reference it directly (`RuntimeTab`) instead of wrapping it in `ReturnType<...>`; keep `ReturnType` for anonymous/inferred shapes and third-party method return types.
- Prefer `export * from "./module"` in pure barrels; when stars create ambiguity, remove the redundant export path instead of keeping named re-exports.
- Prefer top-level `import type` over inline `import("pkg").Type` in type positions; dynamic `import()` stays for lazy-load / optional / binary-entry boundaries.
- Prefer `Promise.withResolvers()` when a deferred must hand out its resolve/reject separately. Keep `new Promise` for event/callback adapters, rejectable timers, `setImmediate`, and `Promise.race` timers that return sentinel values. Pure-Node `pi-packages/` may wrap `setTimeout`.

## Commands

- **Package tooling is Bun**: `bun install` only; lockfile is `bun.lock` (never commit `package-lock.json` / yarn.lock / pnpm-lock.yaml). Orchestrate scripts with `bun run …`. Do not use npm/yarn/pnpm for installs. Run product code with `bun` (`run.sh`, shebang); never Node for paths that call `Bun.*`.
- **Search & File Exploration Tools**:
  - Always prefer `fd` over `find` for file and directory discovery.
  - Always prefer `rg` (ripgrep) over `grep` for content and symbol searches.
- **Git Commit Messages**: Use Conventional Commits format (e.g. `feat: ...`, `fix: ...`, `refactor: ...`, `test: ...`, `docs: ...`, `chore: ...`). No emojis.
- NEVER commit unless asked.

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

**Exception: `pi-packages/` must stay pure Node** — see **Built-in Extensions**. Pure `pi` loads those packages under Node; `Bun.*` there silently breaks features (e.g. `$` skill completion, external editor, goal inline commands).

### Quick reference

| Operation       | Use                                       | Not                             |
| --------------- | ----------------------------------------- | ------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`               | `readFileSync`, `writeFileSync` |
| Spawn process   | `` $`cmd` ``, `Bun.spawn()`               | `child_process`                 |
| Sleep           | `Bun.sleep(ms)`                           | `setTimeout` promise            |
| Binary lookup   | `Bun.which("git")`                       | `spawnSync(["which", "git"])`   |
| HTTP server     | `Bun.serve()`                             | `http.createServer()`           |
| SQLite          | `bun:sqlite`                              | `better-sqlite3`                |
| Hashing         | `Bun.hash()`, `Bun.password.hash/verify` (bcrypt), WebCrypto | `node:crypto`    |
| Path resolution | `import.meta.dir`, `import.meta.path`     | `fileURLToPath` dance           |
| JSON5           | `Bun.JSON5.parse()` / `.stringify()`      | `json5` package                 |
| JSONL           | `Bun.JSONL.parse()` / `.parseChunk()`     | `text.split("\n").map(JSON.parse)` |
| String width    | `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })` | `get-east-asian-width`, custom  |
| Text wrapping   | `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })` | custom ANSI-aware wrappers      |

### Process execution

Prefer Bun Shell (`` $`cmd` ``) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
  const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Methods: `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`.

Use `Bun.spawn`/`Bun.spawnSync` only for: long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or process control (signals, kill, complex lifecycle).

When using `pipe` mode, cast the stream:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

### Node module imports

Always use **namespace imports** for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

- Async-only file → `node:fs/promises`.
- Needs both sync and async → `node:fs`, then `fs.promises.xxx` for async.

### File I/O

Prefer Bun:

```typescript
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // auto-creates parent dirs
```

Use `node:fs/promises` for directory ops (`fs.mkdir`, `fs.rm`, `fs.readdir`) — Bun has no native directory APIs. Avoid sync APIs in async flows; use sync only when forced by a synchronous interface.

**Anti-patterns:**

- `existsSync`/`readFileSync`/`writeFileSync` in async code → `Bun.file()` APIs.
- `mkdir(dirname(path), …)` before `Bun.write(path, …)` → redundant; `Bun.write` handles it.
- `if (await file.exists()) { await file.json() }` → two syscalls plus race. Use try-catch on `ENOENT`:

  ```typescript
  try {
    return await Bun.file(path).json();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  ```

- Multiple `Bun.file(path)` handles for the same path (including across `checkX`/`loadX` helpers).
- `Buffer.from(await Bun.file(x).arrayBuffer())` → `await fs.readFile(path)`.

### Streams

Prefer centralized helpers over copy-pasted reader loops:

```typescript
async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const text = await readStream(stream);
  for (const line of text.split("\n")) yield line;
}

const text = await readStream(child.stdout);
for await (const line of readLines(stream)) {
  /* ... */
}
```

Manual reader loops only when the protocol requires it (SSE, streaming JSON-RPC).

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
- For behavior changes and bug fixes that protect a real contract: focused failing test first, then the smallest fix. Do not invent a test for tiny low-risk restores (e.g. putting a flag back to its default) that would only assert an internal field.

### Banned

- No placeholder, tautology, or theater tests: `expect(true).toBe(true)`, bare `not.toThrow()`, non-empty / length-grew checks, "prompt exists" without semantic assertion, or expected values recomputed by calling the code under test itself.
- No mock theater: never mock the code under test; mock only true external boundaries (network, paid providers, OS sandbox). Prefer real objects, tmpdirs, and existing test helpers (`test/helpers/`).
- Don't duplicate coverage across abstraction levels. If an integration test already proves the behavior, drop the narrower unit test that restates it through mocks.
- Smoke tests only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- **Never source-grep.** A test that reads an implementation file (`.ts`/`.rs`/build script) and asserts on its *text* — `expect(src).toContain("someCall()")`, `.toMatch(/import .../)`, `.not.toContain("oldName")`, or "comment must say X" — is banned. It tests how code *looks*, not what it *does*. Assert the observable contract instead (run the code, check output/state/error); enforce structural invariants with a type test or lint/biome rule — never a string scan of the source. (Reading a file your code *wrote* — apply-patch result, generated bundle, temp fixture — is fine; that is behavior.)
- Do not delete, skip, or weaken a failing test to go green unless the user explicitly authorizes it.
- Do not claim tests pass from stale output, assumption, or code inspection alone — re-run and use this run's result.

### How to run

- Runner: `bun test --isolate --timeout=60000` (node:test-style tests under Bun so `Bun.*` works; `--isolate` avoids cross-file test nesting bugs). Root tests live in flat `test/*.test.ts`; package tests are colocated as `pi-packages/*/*.test.ts`.
- Focused (default while iterating):
  - `bun test --isolate --timeout=60000 test/<file>.test.ts`
  - `bun test --isolate --timeout=60000 pi-packages/<pkg>/<file>.test.ts`
- Changed-only (fastest inner loop): `bun run test:changed` — walks the import graph backwards from the uncommitted diff (unstaged + staged + untracked) and runs only the test files that reach it. Pass a base to compare against a branch instead: `bun run test:changed --changed=main`. `--changed` runs serially on its own, so the script pairs it with the same `--parallel` worker count as the root suite.
- Package tests: `bun run test:packages`
- Root suite: `bun run test` (`test/*.test.ts` only; runs files in parallel workers via `--parallel=min(16, cores)` — capped because worker counts above the core count starve timing-sensitive tests). `--timings` + `--update-timings` read and rewrite `.test-timings.json` (gitignored) so each run starts the slowest files first; a missing file is created by the next run.
- Full sequential gate: `bun run check` (typecheck + build + root tests)
- Parallel package-oriented gate: `./test-all.sh` (`bun run --parallel --no-exit-on-error typecheck build lint test:packages`; does **not** run full `test/*.test.ts`). Every job runs to completion even when one fails, and the script exits with the first failing job's code.
- Dependency version comparison: `bun pm diff <pkg>` (lockfile version → latest) or `bun pm diff <pkg>@<from> <to> [paths...]`. It reports changed files, new install scripts, and new `child_process`/`fs`/`net`/`vm` imports before the diff, un-minifies, and skips formatting-only changes. Scoping it to the paths a `patches/` file touches sizes a patch rebase up front — see `.agents/skills/pi-packages-upgrade/SKILL.md`.
- `bun install` applies `patchedDependencies` from `patches/`. `postinstall` only runs `bun run scripts/install-pi-extensions.ts --postinstall` (TTY: optional interactive install of missing recommended third-party Pi packages; CI/non-TTY: warn only; never fails the parent install). Manual: `bun run install:extensions` or `./install-pi-extensions.sh`. To change a Pi patch: edit the package in `node_modules` after `bun patch <pkg>`, then `bun patch --commit <pkg>`.
- Before finishing a TypeScript behavior change: run the focused test(s) you added or changed until green, then the narrowest gate that covers the touch surface (`test:packages` for package work, `bun run check` and/or `./test-all.sh` as appropriate). Fix until green.

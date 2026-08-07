# AGENTS.md

## TUI Validation

- For TUI work, code inspection and unit tests are not sufficient evidence. Run the TUI interactively, capture screenshots, and verify core keyboard flows before claiming the UI works.
- When you need to actually launch mixcode-pi to test it, use tmux. Prefer an isolated socket via `tmux -L <label>` (e.g. `tmux -L mixcode-test`) so your sessions never collide with unrelated ones. On an isolated socket, `tmux -L <label> kill-server` is safe. Otherwise, on the default socket, do not run `tmux kill-server` (it would kill unrelated sessions); kill only the specific tmux session/window you created.

## Pi Integration

- Before implementing any feature, first check whether Pi-related packages already provide it. Prefer reusing components, APIs, and UI/TUI building blocks from installed `@earendil-works/pi-*` packages (and the Pi SDK docs at https://pi.dev/docs/latest/sdk and https://pi.dev/docs/latest/tui) over writing MixCode-local equivalents.
- Only build custom code when the requirement is not covered by those packages (or the user explicitly requires a different behavior). Do not reimplement selectors, editors, dialogs, markdown, keybindings, session/tree UI, or similar just because a local rewrite is convenient.
- Pi docs (check these before inventing local APIs or UI):
  - Upstream SDK: https://pi.dev/docs/latest/sdk
  - Upstream TUI: https://pi.dev/docs/latest/tui
  - Package catalog: https://pi.dev/packages
  - Local MixCode↔Pi compatibility: `docs/extension-compatibility.md`
  - Local architecture mapping (not upstream API source): `docs/architecture.md`
  - Local MixCode TUI component catalog (chrome / overlays / transient): `docs/tui-components.md`

## Built-in Extensions

- Built-in Pi extensions live in `pi-packages/<name>/`. Each package has a `package.json` with a `pi.extensions` field and an `index.ts` default-exporting an `ExtensionFactory`.
- Name first-party packages with the `mpi-` prefix (directory, `package.json` name, and `binary-entry.ts` `builtinPackages` key must all match, e.g. `mpi-skill-refs`). Vendored upstream packages keep their original name. Do not prefix runtime protocol strings such as command names, `customType`, or keymap actions.
- At startup, `ensurePackageExtensions` (in `src/core/ensure-package-extensions.ts`) copies all valid packages to the effective agent dir's `extensions/` (`<agentDir>/extensions/`, where `agentDir` follows `MIXCODE_CODING_AGENT_DIR` → `PI_CODING_AGENT_DIR` → default `~/.pi/agent`), making them discoverable by Pi's file-system loader — including subagent sessions.
- For the compiled binary, `binary-entry.ts` embeds each package's files via `import ... with { type: "text" }` and passes them as `builtinPackages` to `materializeBinaryRuntimeAssets`, which writes them to `runtimeDir/packages/` before `ensurePackageExtensions` runs.
- To add a new built-in extension: create `pi-packages/mpi-<name>/package.json` + `index.ts`, then add the corresponding text imports in `binary-entry.ts`.
- **No Bun APIs in `pi-packages/`.** These packages are installed into `~/.pi/agent/extensions/` and also run under pure upstream `pi` (Node + jiti), not only under `mpi` (Bun). Use `node:*` stdlib (`fs`, `fs/promises`, `child_process`, `path`, `os`, …). Do not call `Bun.*`, `bun:*` imports, or Bun Shell (`` $`…` ``). Product code under `src/` may still prefer Bun; this rule is package-only.

## Slash Commands

- Slash commands are registered in `LOCAL_COMMANDS` (`src/core/commands.ts`); their `description` is shown in the command palette and slash autocomplete.
- Persistence has three tiers: global (Pi's `<agentDir>/settings.json`, survives restart, shared across workdirs and with Pi), workdir (`mixcode_state.json`, per-workdir), and session (in-memory or `applyOverrides`, dropped on reload/restart).
- Any command that persists to Pi's global `settings.json` (survives restart, shared across workdirs and with Pi) MUST prefix its `description` with `[global]`, so users can see the global-persistence effect before running it. Example: `/hide-thinking`.
- Do not add the `[global]` prefix to workdir-level or session-level commands; the absence of a prefix means the command is not a globally-persisted setting.

## Code Quality

- Follow a TDD flow for behavior changes and bug fixes **when the change protects a real contract**: focused failing test first, then the smallest fix. Do not invent a test for tiny low-risk restores (e.g. putting a flag back to its default) that would only assert an internal field — see **Test Guidelines**.
- Prefer TypeScript source files under 1000 lines; split into focused modules when a file grows mainly by unrelated concerns. The limit is a guideline, not a hard block — a coherent file may exceed 1000 lines when splitting would only hurt clarity.
- Split on real seams only: a boundary that is independently testable, has a single clear responsibility, or is a replaceable interface. File length alone is not a seam. Prefer putting new code in the existing neighbor module; prefer merging thin single-caller satellites over further splits.
- Add concise English comments in TypeScript source files for non-obvious intent: invariants, side effects, ordering constraints, edge cases, and rationale for surprising decisions. Do not comment self-evident syntax or restate the code; add them when modifying an uncommented complex area as well.
- Before finishing TypeScript behavior changes, follow **Test Guidelines** (focused test first, then the narrowest gate that covers the touch surface). Use `bun run format` only when formatting is intentionally requested or scoped, and do not claim formatting was run unless the command succeeds.
- Keep formatting changes intentional and scoped. Do not mix broad reformatting with behavioral changes unless the formatter requires it.
- Do not add or keep `src/` exports (including via `src/index.ts` barrels) that exist only so tests can call them. Tests must exercise the real production call path or compose production helpers; if a helper is test-only, put it under `test/` — never promote it into product modules for test convenience.

### TypeScript Style

- Avoid `any` unless no practical alternative; prefer real types from libraries or `node_modules` over guessed shapes.
- When a function's return type is already a named type, reference it directly (`RuntimeTab`) instead of wrapping it in `ReturnType<...>`; keep `ReturnType` for anonymous/inferred shapes and third-party method return types.
- Prefer `export * from "./module"` in pure barrels; when stars create ambiguity, remove the redundant export path instead of keeping named re-exports.
- Prefer top-level `import type` over inline `import("pkg").Type` in type positions; dynamic `import()` stays for lazy-load / optional / binary-entry boundaries.
- Prefer `Promise.withResolvers()` when a deferred must hand out its resolve/reject separately; keep `new Promise` for simple timer wrapping (`setTimeout`/`setImmediate`).

## Commands

- **Package tooling is Bun**: `bun install` only; lockfile is `bun.lock` (never commit `package-lock.json` / yarn.lock / pnpm-lock.yaml). Orchestrate scripts with `bun run …`. Do not use npm/yarn/pnpm for installs.
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
| Hashing         | `Bun.hash()`, `Bun.password.*`, WebCrypto | `node:crypto`                   |
| Path resolution | `import.meta.dir`, `import.meta.path`     | `fileURLToPath` dance           |
| JSON5           | `Bun.JSON5.parse()` / `.stringify()`      | `json5` package                 |
| JSONL           | `Bun.JSONL.parse()` / `.parseChunk()`     | `text.split("\n").map(JSON.parse)` |
| String width    | `Bun.stringWidth()`                       | `get-east-asian-width`, custom  |
| Text wrapping   | `Bun.wrapAnsi()`                          | custom ANSI-aware wrappers      |

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
- Existence check + try-catch around the same read → drop the existence check.

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

### Misc

- **Sleep**: `await Bun.sleep(ms)`, never `new Promise(r => setTimeout(r, ms))`.
- **Password hashing**: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- **String width**: `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })`.
- **Wrapping**: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

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

- Runner: `bun test --isolate --timeout=60000` (node:test-style tests under Bun so `Bun.*` works; `--isolate` avoids cross-file test nesting bugs). Root tests live in flat `test/*.test.ts`; package tests are colocated as `pi-packages/*/*.test.ts`.
- Focused (default while iterating):
  - `bun test --isolate --timeout=60000 test/<file>.test.ts`
  - `bun test --isolate --timeout=60000 pi-packages/<pkg>/<file>.test.ts`
- Package tests: `bun run test:packages`
- Root suite: `bun run test` (`test/*.test.ts` only)
- Full sequential gate: `bun run check` (typecheck + build + root tests)
- Parallel package-oriented gate: `./test-all.sh` (typecheck + build + lint + package tests; does **not** run full `test/*.test.ts`)
- Package manager / runtime: Bun — install with `bun install`; lockfile is `bun.lock` (do not commit `package-lock.json`). Run product code with `bun` (`run.sh`, shebang); do not use Node to execute product paths that call `Bun.*`.
- `postinstall` runs `patch-package` only. pi-tui keybindings bridge supports both single-instance (bun/npm dedupe) and dual-instance (npm shrinkwrap nested) layouts without layout scripts.
- When running backend unit tests, enforce a hard timeout of 60 seconds to avoid stuck tasks.
- TUI/UI claims still require interactive proof per **TUI Validation**; unit tests alone are not enough. Optional automated smoke: `MIXCODE_RUN_TMUX_TUI_SMOKE=1` with `test/tui-smoke.test.ts`.
- Before finishing a TypeScript behavior change: run the focused test(s) you added or changed until green, then the narrowest gate that covers the touch surface (`test:packages` for package work, `bun run check` and/or `./test-all.sh` as appropriate). Fix until green.

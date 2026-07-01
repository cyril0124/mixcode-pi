# AGENTS.md

## TUI Validation

- For TUI work, code inspection and unit tests are not sufficient evidence. Run the TUI interactively, capture screenshots, and verify core keyboard flows before claiming the UI works.
- When you need to actually launch mixcode-pi to test it, use tmux. Do not run `tmux kill-server` (it would kill unrelated sessions); kill only the specific tmux session/window you created.

## Pi Integration

-  Do not use OpenCode configuration or UI concepts as product logic unless explicitly requested. Model configuration should use Pi-native configuration sources.
- Before implementing any feature, first check whether the Pi SDK provides native support for it. The Pi SDK means Pi's official runtime, extension, package, tool, command, UI, and TUI APIs documented at https://pi.dev/docs/latest/sdk and https://pi.dev/docs/latest/tui; prefer those native capabilities when available instead of rebuilding equivalent functionality.

## Built-in Extensions

- Built-in Pi extensions live in `pi-packages/<name>/`. Each package has a `package.json` with a `pi.extensions` field and an `index.ts` default-exporting an `ExtensionFactory`.
- At startup, `ensurePackageExtensions` (in `src/core/ensure-package-extensions.ts`) copies all valid packages to `~/.pi/agent/extensions/`, making them globally discoverable by Pi's file-system loader — including subagent sessions.
- For the compiled binary, `binary-entry.ts` embeds each package's files via `import ... with { type: "text" }` and passes them as `builtinPackages` to `materializeBinaryRuntimeAssets`, which writes them to `runtimeDir/packages/` before `ensurePackageExtensions` runs.
- To add a new built-in extension: create `pi-packages/<name>/package.json` + `index.ts`, then add the corresponding text imports in `binary-entry.ts`.

## Code Quality

- Follow a TDD flow for behavior changes and bug fixes: first add or update a focused test that reproduces the expected behavior or failure, confirm it fails when feasible, then implement the smallest code change that makes the test pass.
- Every TypeScript source file must not exceed 700 lines. If it exceeds, split it into smaller focused modules before adding more code.
- Add code comments in TypeScript source files at important or non-obvious places to explain intent, edge cases, and complex logic. Prioritize clarity for future readers over verbosity.
- Coverage gates should preserve high signal: keep lines/statements/functions at 95%, keep global branch coverage at 90%, and prefer targeted tests for meaningful behavior over tests that only exercise incidental defensive branches.
- For TypeScript code changes, run `./test-all.sh` (parallel: typecheck, build, lint) before finishing. Fallback to sequential `npm run check` if parallel execution has issues. Use `npm run format` or `./format.sh` only when formatting is intentionally requested or scoped, and do not claim formatting was run unless the command succeeds.
- Keep formatting changes intentional and scoped. Do not mix broad reformatting with behavioral changes unless the formatter requires it.

# AGENTS.md

## TUI Validation

- For TUI work, code inspection and unit tests are not sufficient evidence. Run the TUI interactively, capture screenshots, and verify core keyboard flows before claiming the UI works.

## Pi Integration

-  Do not use OpenCode configuration or UI concepts as product logic unless explicitly requested. Model configuration should use Pi-native configuration sources.
- Before implementing any feature, first check whether the Pi SDK provides native support for it. The Pi SDK means Pi's official runtime, extension, package, tool, command, UI, and TUI APIs documented at https://pi.dev/docs/latest/sdk and https://pi.dev/docs/latest/tui; prefer those native capabilities when available instead of rebuilding equivalent functionality.

## Code Quality

- Follow a TDD flow for behavior changes and bug fixes: first add or update a focused test that reproduces the expected behavior or failure, confirm it fails when feasible, then implement the smallest code change that makes the test pass.
- Every TypeScript source file must not exceed 700 lines. If it exceeds, split it into smaller focused modules before adding more code.
- Add code comments in TypeScript source files at important or non-obvious places to explain intent, edge cases, and complex logic. Prioritize clarity for future readers over verbosity.
- Coverage gates should preserve high signal: keep lines/statements/functions at 95%, keep global branch coverage at 90%, and prefer targeted tests for meaningful behavior over tests that only exercise incidental defensive branches.
- For TypeScript code changes, run `npm run typecheck`, `npm run test`, and `npm run check` before finishing. Use `npm run format` or `./format.sh` only when formatting is intentionally requested or scoped, and do not claim formatting was run unless the command succeeds.
- Keep formatting changes intentional and scoped. Do not mix broad reformatting with behavioral changes unless the formatter requires it.

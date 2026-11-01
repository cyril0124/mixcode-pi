# AGENTS.md

## Repository Boundary

- The pinned Pi fork at `vendor/pi/` owns the CLI, interactive UI, sessions, and provider runtime. Read `vendor/pi/AGENTS.md` and `vendor/pi/MIXCODE.md` before changing that repository; keep its npm lockfile and upstream-sync conventions there.
- This repository owns `pi-packages/`, the single-file build/installer, and extension tests.
- Keep the fork at a commit recorded by the submodule gitlink. Never publish or commit either repository without explicit user authorization. A dirty submodule is not a reproducible dependency.

## Conversation And Documentation

- Use concise, direct technical prose. No emojis in responses, PR comments, or code. Answer questions before edits; state agreement or disagreement before describing feedback changes.
- Synchronize English and Chinese README/docs pairs.
- Host behavior belongs in `vendor/pi/docs/`; extension behavior belongs in each `pi-packages/<name>/README.md` and `README.zh.md`. Link to one authoritative description instead of copying fork documentation into this repository.
- Material user-visible features go in both root READMEs.

## Build And Dependencies

- `install.sh` installs exactly one executable at `<prefix>/bin/<name>` (default `mpi`). `release.sh` cross-compiles the same entry, and `run.sh` rebuilds a local executable when inputs change. Bun and Node/npm are build prerequisites, not runtime prerequisites for the installed executable.
- The fork uses `npm ci --ignore-scripts` with `vendor/pi/package-lock.json`. Root extension checks use `bun install --ignore-scripts` with `bun.lock`; root overrides must resolve all Pi SDK packages to the pinned fork, including transitive dependencies.
- `scripts/ensure-fork-dependencies.sh` reuses installed fork dependencies only when `tsc` exists and the lockfile SHA-256 matches the successful-install stamp in ignored `dist/`. Release and root checks force `npm ci`.
- `scripts/ensure-fork-model-data.sh` refreshes and validates the fork model catalog online on every fork build. Build, install, release, and development paths share this step; a failed refresh stops the build.
- `scripts/generate-fork-docs.ts` and `scripts/generate-fork-examples.ts` generate ignored import manifests from fork documentation and coding-agent docs/examples. Run both before bundling. `scripts/fork-binary-entry.ts` embeds docs, examples, themes, workers and built-in packages; `scripts/fork-binary-assets.ts` extracts them at runtime.
- When adding or moving an embedded extension file, update both the static imports and its entry under `builtinPackages` in `scripts/fork-binary-entry.ts`. A package's directory name, manifest name, and embed key must agree and start with `mpi-`.
- `scripts/ensure-package-extensions.ts` installs embedded packages into the effective `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Retain its process-safe install lock and hash-based update; package skills are discovered through each package's public resource declarations, not copied to `<agentDir>/skills`.

## First-Party Extensions

- Packages live under `pi-packages/<name>/` and declare their extension/skill resources in `package.json`. Keep extensions usable with pure Pi under Node and jiti: use `node:*`, not Bun-only APIs.
- Packages must not import or depend on one another. Reuse public fork SDK APIs; put product-specific behavior in packages when it can remain independent of the host. Host-only fixes belong in the fork's `mixcode/` areas.
- Commands with arguments support `help`, `--help`, and `-h`. Commands backed by user-edited JSON also provide `config` and a matching configuration skill. Validation errors are explicit and should not appear as fake success.
- Tests live beside each extension. Shared test fixtures still used by packages live in `test/helpers/`. Keep test-only helpers out of production exports and preserve real event, ordering, and failure-path behavior.

## Verification

- Run `bun run check` after integration changes: it builds the fork and binary, refreshes local SDK dependencies, then typechecks, lints, and runs package tests. For focused checks use `bun test --isolate --timeout=60000 pi-packages/<pkg>/<file>.test.ts`.
- Validate interactive behavior in an isolated tmux socket and capture a repeatable artifact. Never treat a successful boot alone as proof that an extension works; exercise a command or tool.
- Preserve existing tests when the behavior remains. Never hide a current product regression by skipping a test.
- Keep formatting and dependency edits scoped. Root changes use `bun install`; fork changes follow its own `AGENTS.md`. Do not use `git reset --hard`, force push, or broad staging across concurrent working trees.

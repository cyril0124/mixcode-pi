---
name: pi-packages-upgrade
description: Compare installed @earendil-works/pi-* to the latest or a chosen pi release, report UX impact and mixcode-pi break risks, then upgrade after explicit confirmation. Use when user asks what is new in pi, whether to upgrade pi packages, upgrade impact, or says upgrade pi / pi-packages-upgrade.
---

# pi-packages-upgrade

For mixcode-pi: report pi package updates and break risks, then upgrade after confirmation. The goal is always to upgrade; the gate only chooses **when**. Never commit or push.

**Language:** user-facing output (report, wrap-up, errors) matches the user's language, including report section titles and table headers.

## Packages (same version)

`@earendil-works/pi-agent-core` · `pi-ai` · `pi-coding-agent` · `pi-tui`

Current: root `package.json`. Latest: https://github.com/earendil-works/pi/releases (or user tag).

## Source of truth: `bun pm diff`

`bun pm diff` compares the published tarballs, so it resolves anything the release notes leave ambiguous.

```sh
bun pm diff @earendil-works/pi-tui                      # bun.lock version → latest
bun pm diff @earendil-works/pi-tui@0.83.0 0.84.2        # two published versions
bun pm diff @earendil-works/pi-tui@0.83.0 0.84.2 'dist/keys.js'   # scoped to paths
```

It prints a summary first — changed files, **new install scripts**, and **new imports of `child_process` / `fs` / `net` / `vm`** — then the diff, with minified files expanded and formatting-only changes dropped. Trailing path patterns scope it.

## Failure modes

| Trigger | First-line fix | If still failing |
|---|---|---|
| Network unavailable (releases / registry unreachable) | Say so and stop; do not invent release notes or diffs | Report stays "network unavailable"; user retries later |
| Already on the target version | Report "already latest" with the current versions; no confirmation line | — |
| `bun install` fails right after the version bump | `patchedDependencies` keys must match the renamed `patches/*@<target>.patch` filenames exactly; fix names first | Mismatched keys keep failing → re-run `bun patch --commit` per package |
| Patch hunk conflicts during `bun patch --commit` | Re-apply the hunks by hand on the new dist; the Step-3 probe lists which hunks upstream moved | A hunk with unclear semantics → verify against the Step-3 touch points before committing |
| `bun pm diff` errors (old bun / registry hiccup) | Upgrade bun or retry; never fabricate the diff | Download both tarballs from npm and diff locally |

## Steps

1. **Versions** — current → target.
2. **Changelog + impact** — build the Changelog and User impact sections defined in *Report shape*. Where a release note is vague or a touch point below looks affected, resolve it with `bun pm diff` and cite what the diff showed. Flag any new install script or new `child_process`/`net`/`vm` import from the summary as a break risk.
3. **Break risk** — quickly check mixcode touch points:
   - `patches/@earendil-works%2Fpi-*@*.patch` / `package.json` `patchedDependencies` (must match package versions; `bun install` fails otherwise). Size the rebase before scheduling it: list the files each patch touches and diff only those. Paths untouched upstream reapply clean; any hit is real rebase work.
     ```sh
     patch='patches/@earendil-works%2Fpi-tui@<current>.patch'
     paths=$(rg -N --no-filename '^\+\+\+ b/' "$patch" | sed 's|^+++ b/||')
     bun pm diff @earendil-works/pi-tui@<current> <target> $paths
     ```
   - private `AgentSession` fields: `runtime-follow-up`, `runtime-lifecycle`, `runtime-events`, `tools`, `retry-settings`
   - `installProviderRegistryUiSync` (incl. native provider)
   - `pi-models` (`allowModelNetwork`, stream `env`)
   - compaction vs `pendingMessages` (MixCode's own queue)
   - nested pi-tui: `binary-entry` / `runtime-pi-tui-bridge`
4. Print the report, end with the confirmation line, and stop (see *Checkpoint*).

## Report shape

Emit a full Markdown report (not plain text). Prefer tables where they help; column layout is flexible—pick headers that fit the release, do not force a fixed schema.

Required sections, in order:

1. **Versions** — current → target for all four packages; release tag/URL.
2. **Changelog** — notable Features / Fixes / Other as a table (or tables). Summarize; do not paste raw changelog prose.
3. **User impact** — daily use / extension-dev / no-op. Name the UI surface or workflow and what users can now do or expect. If there is no user-visible impact, say so. Do not describe the code-level cause.
4. **Break risks** — hard / soft / free against the mixcode touch points in Steps. Level criteria: **hard** = MixCode fails typecheck/tests until adapted (removed or renamed exports, changed private-field shapes, patch anchor gone); **soft** = still compiles, but behavior or the patch rebase needs verification; **free** = touch point untouched upstream.
5. **Upgrade work (preview)** — deps, patch rebase, code fixes, tests.
6. End with: `Confirm: proceed? (revise / run / run-verify)`

## Checkpoint

Stop after the report; never recommend waiting or skipping. A trigger phrase ("upgrade pi", "pi-packages-upgrade", ...) only starts the skill — it is never run authorization. Every invocation begins with the report; continue only when the latest request contains:

- `revise`: change target/scope and reprint the full report + confirmation line.
- `run`: perform the upgrade (step below).
- `run-verify`: upgrade, then verify with an independent subagent against what changed.
- A specific tag (e.g. `v0.82.0`): treat as `run` for that target.
- No-confirmation wording: omit the confirmation line; upgrade only if the request also authorizes implementation.

Do not upgrade on "what's new" alone.

## Run

1. Bump all four packages + lockfiles to the target version.
2. Rebase the three `bun patch` files in `patches/` to the new versions, then `bun patch --commit` each package so `patchedDependencies` matches. The Step 3 probe identifies which hunks upstream moved.
3. Smallest fixes only for hard break risks. Contract test if behavior changes.
4. Do not wire new upstream features into MixCode UI/commands unless the user asks (package bump + break-risk fixes only).
5. Verify: `bun run typecheck` + focused tests for what you touched; `bun run check` if broad.
6. Short wrap-up: files changed, tests run, skipped work. Do not claim green from stale output.

## Run-Verify

1. Complete **Run** first.
2. Independent subagent checks the real diff against: versions aligned, patch filename matches, hard touch points still sound, typecheck/tests actually run.
3. Fix only failed items; re-verify until clean or a real blocker.

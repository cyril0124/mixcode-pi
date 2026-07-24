# rpiv-todo (vendored)

This package was vendored from the upstream open-source extension
**`@juicesharp/rpiv-todo`** at version `1.20.0` and is now maintained
in-tree. The current in-tree version is `2.1.0-mixcode.1`: selected
user-facing runtime updates from upstream `2.1.0` are ported on top of the
MixCode-specific session isolation patch.

## Attribution

- Upstream package: `@juicesharp/rpiv-todo`
- Upstream author: juicesharp
- Upstream repository: https://github.com/juicesharp/rpiv-mono
  (directory `packages/rpiv-todo`)
- License: MIT (see `LICENSE`)

The shared config utilities under `vendor/rpiv-config.ts` are vendored from
the sibling upstream package **`@juicesharp/rpiv-config`** (version `1.20.0`,
MIT, same author/repository, directory `packages/rpiv-config`). They were
inlined because the Pi extension loader resolves bare imports against a fixed
alias table that does not include the `@juicesharp/*` scope, so the original
`import ... from "@juicesharp/rpiv-config"` could not resolve once the package
lives under `pi-packages/`.

The upstream README is preserved verbatim as `README.md.upstream`.

## Local modifications

The upstream extension stored its todo list in a single module-level state
cell (`state/store.ts`) and a single `TodoOverlay` instance (`index.ts`).
Because the Pi extension module is loaded once per process and shared by every
tab, all MixCode tabs ended up reading and writing the same todo list — the
overlay above the editor was shared across tabs.

This vendored copy is patched to namespace both the state store and the
overlay by **session id** (`ctx.sessionManager.getSessionId()`), so each tab /
session keeps its own independent todo list. Search for `ponytail:` and
`session id` comments to find the touched seams:

- `state/store.ts` — state cell is now a `Map<sessionId, TaskState>`.
- `index.ts` — `TodoOverlay` is now a `Map<sessionId, TodoOverlay>`; every
  lifecycle handler resolves the current session id from `ctx`.
- `todo.ts` — the `todo` tool and `/todos` command resolve the session id from
  their execution context before reading/writing state.
- `config.ts` — imports the vendored `rpiv-config` instead of the npm package.

## Ported from upstream 2.1.0

- Configurable overlay height via `maxWidgetLines`.
- Per-tab collapse/expand shortcut via `collapseKey` (default `ctrl+shift+t`).
- Clear `No change` feedback for no-op updates.
- Updated overlay colors, theme refresh behavior, and localized collapse labels.

Configuration lives at `~/.config/rpiv-todo/config.json`:

```json
{
  "maxWidgetLines": 12,
  "collapseKey": "ctrl+shift+t"
}
```

`maxWidgetLines` counts content rows including the heading, defaults to `12`,
and must be at least `3`. `collapseKey` accepts Pi keybinding strings such as
`alt+o`; set it to `"off"` to register no collapse shortcut. Key changes take
effect after `/reload`, while height changes apply on the next repaint.

The upstream single-foreground overlay policy is intentionally not ported;
MixCode keeps one `TodoOverlay` per session so every tab has its own widget.

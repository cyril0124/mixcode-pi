# Pi Extension Compatibility

[中文文档](extension-compatibility.zh.md)

This document outlines MixCode's compatibility boundaries, installation methods, verified capabilities, and known limitations regarding Pi packages and extensions. The official Pi package catalog defines packages as npm-published extensions, skills, prompt templates, and themes, installed via `pi install npm:<package>`. MixCode adheres to the exact same Pi resource loader and package discovery semantics.

References:

- https://pi.dev/packages
- https://pi.dev/docs/latest/sdk
- https://pi.dev/docs/latest/tui

## Current State

```text
pi.dev/packages
  │
  ├─ extension / skill / prompt / theme npm package
  │
  v
.pi/settings.json packages
  │
  v
Pi resource loader
  │
  ├─ extensions -> ExtensionRunner
  ├─ skills     -> system prompt / completion / prompt build
  ├─ prompts    -> slash command / prompt template
  └─ themes     -> theme discovery / MixCode theme switching
        │
        v
MixCode adapters
  ├─ tools / commands
  ├─ lifecycle events
  ├─ UI primitives
  ├─ message renderer
  └─ tool renderer
```

MixCode can load and run Pi packages, but does not claim 100% compatibility across every package in the catalog. The benchmark is whether a package's core commands and tools actually execute end-to-end.

`ctx.ui.custom()` covers two Pi TUI semantics:

```text
ctx.ui.custom(factory)
  └─ Temporarily replaces the MixCode editor; restores previous editor upon done()
  └─ ctx.ui.getEditorText / setEditorText / pasteToEditor still target the underlying editor

ctx.ui.custom(factory, { overlay: true })
  └─ Displays floating overlay via pi-tui overlay; disposes upon hide()/done()

ctx.ui.select / confirm / input
  └─ Replace the editor area while open; closing keeps the close-time editor text
     (mid-dialog setEditorText writes survive, matching Pi)
```

`ctx.ui.onTerminalInput` handlers fire before the focused editor and may consume or rewrite the input, but — deviating from Pi — MixCode suppresses them while a tui overlay or a pending extension interaction (`select`/`confirm`/`input` dialog, pending `custom()`) is active. Pi extensions self-guard by peeking the real TUI's focused component; MixCode widget factories receive an isolated `NullTerminal` TUI without focus state, so the host suppresses dispatch instead to keep an open dialog's keys.

`ToolExecutionComponent` treats an extension `renderCall` or `renderResult` return of `undefined` as a request for Pi's native fallback. Renderer exceptions remain visible as error text; result-renderer exceptions also retain the native raw-result fallback.

`ctx.ui.setTitle(title)` writes the terminal title (OSC 0) immediately when the calling session's tab is active. Inactive tabs store the title, and it is re-applied when their tab becomes active. Switching to a tab without a stored title leaves the terminal title unchanged (Pi semantics: the title persists until overwritten).

## Installation

Declare packages in project-level Pi settings:

```json
{
  "packages": [
    "npm:<package-name>",
    "npm:pi-web-access"
  ]
}
```

File location:

```text
<project>/.pi/settings.json
```

MixCode loads project package sources through the Pi resource loader on startup. Do not rely on packages in `refs/`; `refs/` is strictly for UI/interaction reference.

## Compatibility Levels

```text
Level 0: Installable
  Package is installed via npm and discovered by the resource loader.

Level 1: Loadable
  Extension factory executes successfully; tools, commands, and renderers register.

Level 2: Interactive
  Commands, tools, UI primitives, and renderers render and respond in MixCode TUI.

Level 3: Functional
  Primary package workflows pass real smoke tests (not mocks or registration checks).
```

MixCode maintains a generic Pi extension compatibility layer and does not bake in proprietary commands, side panels, or smoke tests for specific external packages.

## Integrated Capabilities

### Runtime

```text
MixCodeRuntime
  -> createAgentSessionServices()
  -> createAgentSessionFromServices()
  -> AgentSession
  -> bindExtensions()
  -> ExtensionRunner
```

Supported:

- extension factory loading
- package resource discovery
- `session_start`
- `session_shutdown`
- `session_before_switch`
- `session_before_fork`
- `session_tree`
- `ctx.newSession()`
- `ctx.fork()`
- `ctx.switchSession()`
- `ctx.navigateTree()`
- `ctx.reload()`
- `/import <jsonl-path> [cwdOverride]` equivalent in MixCode

System prompts, AGENTS, and project context flow directly through the Pi resource loader pipeline.

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

`ctx.ui.onTerminalInput` handlers fire before the focused editor and may consume or rewrite the input, but, deviating from Pi, MixCode suppresses them while a tui overlay or a pending extension interaction (`select`/`confirm`/`input` dialog, pending `custom()`) is active. Pi extensions self-guard by peeking the real TUI's focused component; MixCode widget factories receive an isolated `NullTerminal` TUI without focus state, so the host suppresses dispatch instead to keep an open dialog's keys.

Exception: when a custom overlay is hidden (`handle.hide()` called by the extension itself), dispatch stays enabled even while other interactions are pending, so the overlay can still receive its recovery shortcut (e.g. ask_user_question's collapse toggle). Editor-slot takeovers without a hidden overlay remain fully suppressed.

`ToolExecutionComponent` treats an extension `renderCall` or `renderResult` return of `undefined` as a request for Pi's native fallback. Renderer exceptions remain visible as error text; result-renderer exceptions also retain the native raw-result fallback.

A tool renderer's `context.invalidate()` invalidates cached output for its component and requests a host repaint. This also refreshes the current chat row after streaming events replace it, including updates from timers and asynchronous callbacks.

`ctx.ui.setTitle(title)` writes the terminal title (OSC 0) immediately when the calling session's tab is active. Inactive tabs store the title, and it is re-applied when their tab becomes active. Switching to a tab without a stored title leaves the terminal title unchanged (Pi semantics: the title persists until overwritten).

### Key-release input

Focused components from `ctx.ui.custom()` (embedded or overlay) and
`ctx.ui.setEditorComponent()` receive terminal key-release events only when
`wantsKeyRelease` is `true`. Changes to that property take effect on the next
input event. The editor slot forwards the current component's declaration;
inactive tabs and hidden overlays do not receive the focused component's input.

Releases retain their original terminal encoding, including navigation keys.
They do not run MixCode shortcuts, browse prompt history, or update the host
editor draft. Components without the opt-in keep ignoring releases. Terminal
input listeners retain the eligibility rules above and can consume or rewrite
an event before component delivery. The terminal must actually send releases
(for example through Kitty's keyboard protocol); no releases are synthesized.

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
- `ctx.scopedModels` (resolved from MixCode's model denylist, see [model management](model-management.md))
- `/import <jsonl-path> [cwdOverride]` equivalent in MixCode

System prompts, AGENTS, and project context flow directly through the Pi resource loader pipeline.

MixCode stores the host prompt in eight ordered transcript sections:

| Section | Content |
| --- | --- |
| `preamble` | Host identity |
| `tools` | Tool descriptions and guidelines |
| `docs` | Documentation references |
| `addendum` | `appendSystemPrompt` |
| `project_context` | Project instructions |
| `skills` | Available skills and reading instructions |
| `extensions` | Sections contributed by extensions |
| `environment` | Date and working directory |

Pi's `diffSystemPromptSections` records changed groups before each model request, including requests between tool calls. Empty groups retain their keys with `""`; this clears the text and preserves the group's position when content returns. Pi joins nonempty groups with a blank line. `/system-prompt` replays the leading system message with every later section patch applied and counts that text and its separators, with a separate display row for each project file. The replay is what the provider receives, so it carries extension sections between runs, when `agentSession.systemPrompt` has already fallen back to the base build options. Extension section names are contained within `extensions` and cannot replace host groups.

Opening a session preserves its recorded history. For a session whose full prompt occupies one `preamble` section, the next request replaces that section with the host identity and adds the remaining groups. Branch navigation and compaction replay the recorded sections and tool declarations.

`before_agent_start` receives the assembled host prompt. Returning `systemPrompt` replaces the provider's leading prompt for that run; persisted instructions remain unchanged.

Provider `stream` / `streamSimple` implementations and `MixCodeStreamFn` receive a normalized `TranscriptContext`. Read instructions and tool declarations with `getCurrentSystemPrompt(context.messages)` and `getCurrentTools(context.messages)`; the context has no separate `systemPrompt` or `tools` fields. Wrappers must preserve system messages and the normalized context. Use `normalizeContext()` when constructing a provider input from a raw `Context`.

Compiled `mpi` embeds Pi TUI's native helpers for macOS, Windows, and Linux X11 on x64 and arm64. `src/cli/binary-assets.ts` extracts them under the process runtime directory's `native/` tree; the pi-tui patch includes `PI_PACKAGE_DIR` in native-module lookup. Loading a helper does not guarantee clipboard access: a platform clipboard service or display must still be available.

When `ctx.switchSession()`, session-selector resume, or `/import` targets a different working directory, the replacement session rebuilds its cwd-bound services. Extension `ctx.cwd`, relative tool paths, project settings, and project resources use the target session's cwd before `session_start` and `withSession` run. An import's explicit cwd override is the effective target. Same-directory replacements reuse services and reload extensions; they do not share services with another live tab. A cancelled switch does not load the target project's extensions.

### Session identity

Session replacement updates tab identity before `withSession`; subsequent prompts target that session. See [Session replacement](workspace-and-tabs.md#session-replacement) for publication, focus, cancellation, and failure behavior.

### New-session initialization

`ctx.newSession({ setup, withSession })` checks `session_before_switch` first.
Cancellation preserves the current session and skips both callbacks.

After the old session shuts down, MixCode creates its replacement and awaits
`setup(newSessionManager)` under the per-tab replacement lock. It synchronizes
message history before emitting `session_start` with reason `new`, then calls
`withSession` with the new context. Both handlers can read the setup entries and
messages.

If setup rejects, the error reaches the caller; `session_start` and `withSession`
do not run. The old session remains shut down. Setup is optional and applies only
to new sessions, not fork or resume.

### Active tools

Before `session_start`, MixCode restores the active tool names replayed from the
current branch's system messages, including compaction checkpoints. A checkpoint
with no tools means an explicit empty selection. New sessions and older histories
without a system message use `defaultTools` or Pi's defaults instead. Defaults seed
those sessions; they do not replace a recorded explicit selection.

Restoration uses the current registered implementations. Unavailable or excluded
tools cannot be restored from declarations. Extensions can then apply current
policy with `pi.setActiveTools()`, including `[]`; startup, clear, session
replacement, reload, and workdir changes preserve that post-start selection.

When syncing another instance's session writes, MixCode updates executable tools
if the branch's recorded tool names changed. Metadata or conversation updates with
unchanged tool names preserve local selections awaiting their next request.

Extensions can dynamically register tools and change the active set. Tool changes
are recorded in the session transcript before the next model request, not in
settings. Reapply extension policy in `session_start` when the runtime is recreated;
in-place disk synchronization does not emit that event.

### Built-in edit fidelity

The built-in `edit` tool preserves characters outside each matched span,
including smart quotes, full-width spaces, and trailing whitespace on edited
lines. Fuzzy matches must start and end at Unicode grapheme boundaries. The
matched original span must normalize to the requested text. A partial match
such as `ix` in `ﬁx` returns a not-found error without writing. Exact matches
use the original text even when other edits in the batch need fuzzy matching.

All `edits[]` entries match against the same original content. Duplicate matches
after normalization or overlapping original spans reject the entire batch before
writing. Diff previews and execution share the matcher. Pi preserves the BOM and
restores the detected line-ending style after editing LF-normalized text; mixed
line endings are not preserved. Extensions that override `edit` define their own
matching behavior.

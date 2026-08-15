# MixCode Pi Architecture

[中文文档](architecture.zh.md)

MixCode is a multi-tab TUI agent built on top of Pi (`pi-tui` / `pi-agent-core` / `pi-ai`). This document records the layering, runtime mapping, keybindings, and commands of the current implementation.

## Overall Structure

```text
┌────────────────────────┐
│ @earendil-works/pi-tui │
│ Root + Editor + Overlay │
└────────────┬───────────┘
             │
             v
┌────────────────────────┐
│ pi-agent-core Agent     │
│ SessionManager          │
│ AgentEvent stream       │
└────────────┬───────────┘
             │
             v
┌────────────────────────┐
│ @earendil-works/pi-ai   │
│ Model + stream + tools   │
└────────────────────────┘
```

## Module Layering

```text
src/
├── cli/
│   └── bootstrap.ts          Startup state, workspace, completion source
├── core/
│   ├── commands.ts           Local slash command parsing and completion sources
│   ├── tabs.ts               Tab creation, deletion, modification, and cycling
│   ├── overlays.ts           Pure state logic for preview, tab jump, shell, etc.
│   ├── questions.ts          Selection and submission models for question UI
│   ├── open-tabs-store.ts    open_tabs.json I/O and cross-instance tab set mutations
│   ├── peer-tab-sync.ts      Cross-instance tab listener and reconciliation (open/close)
│   ├── state-store.ts        TUI state and workspace persistence
│   └── system-prompt.ts      Construct system prompt via Pi resource loader
├── agent/
│   ├── runtime.ts            MixCodeRuntime -> Pi Agent/Session
│   ├── tools.ts              Merge Pi built-in tools and extension tool owners with Tool Owners summary
│   └── faux-stream.ts        Faux model stream for testing and local demo
└── ui/
    ├── app.ts                pi-tui Root, Editor, and global key handling
    ├── agent-tab-actions.ts  Tab lifecycle actions like openExistingAgentTab / closeExistingAgentTab
    ├── rendering.ts          Rendering for header/tab/status/panel/floating panel
    └── completion.ts         Completion for / and @ ($skill completion provided by mpi-skill-refs extension)
```

## Runtime Mapping

```text
User Input
  │
  ├─ Normal prompt
  │    └─ Forwarded as-is to Pi AgentSession.prompt()
  │        ├─ $skill reference (expanded by mpi-skill-refs extension in Pi native pipeline)
  │        ├─ /skill: and prompt templates (expanded by Pi native _expandSkillCommand / expandPromptTemplate)
  │        ├─ @file reference
  │        └─ Does not inject AGENTS.md directly; project context enters system prompt
  │
  ├─ /local-command
  │    ├─ Pure UI state: /toggle-todo /preview /mark-done
  │    ├─ Session operations: /new-session /fork /compact /delete-session
  │    └─ Prompt templates: /goal /compact
  │
  └─ !shell / !!shell
       └─ Dispatched to Pi AgentSession.executeBash (!! = excludeFromContext)
            ├─ Appended to session bashExecution
            ├─ UI rendered as user-bash block
            └─ Kept in pending area during streaming, merged into main chat after agent_end

MixCodeRuntime
  │
  ├─ SessionManager        Save / restore / fork / clear-replace / delete session
  ├─ Prompt History        getPromptHistory() reads user prompts on current SDK branch; restored to tab.promptHistory
  ├─ Agent                 Executes prompts and tools
  ├─ AgentEvent            Mapped to tab status, chat, todos, questions, goal
  └─ pi-ai Model           Resolves provider/modelId; faux provider uses local stream
```

## UI and Keybindings

`Tab` and `Shift+Tab` cycle tabs only when Editor autocomplete is inactive, avoiding stealing candidate selection behavior for `/`, `$`, and `@`.

```text
┌────────────────────────────────────────────────────────────┐
│ Header: MixCode                                            │
├────────────────────────────────────────────────────────────┤
│ [Config] [Agent-01] [Agent-02*]        Ctrl+T:Jump         │
├────────────────────────────────────────────────────────────┤
│ Status: Context / State / Model                            │
├────────────────────────────────────────────────────────────┤
│ Chat (user / assistant / tool / bash)                      │
│ optional: extension side panel on the right                │
├────────────────────────────────────────────────────────────┤
│ Shell / Markdown Preview overlays                           │
├────────────────────────────────────────────────────────────┤
│ Prompt Editor (with / $ @ completion)                      │
└────────────────────────────────────────────────────────────┘
```

| Keybinding | Action | Description |
|---|---|---|
| `Tab` | Next Tab | Does not switch tabs when autocomplete is active |
| `Shift+Tab` | Previous Tab | Does not switch tabs when autocomplete is active |
| `Ctrl+P` | Open Command Palette | Filter and execute slash commands and local commands |
| `Ctrl+T` | Tab Jump | Open full-screen tab list overlay for quick switching |
| `Escape` | Close Overlay / Exit Vim | Close preview / jump / palette / vim modes |
| `Ctrl+C` | Interrupt Agent Run | Stop generation or tool execution |
| `Ctrl+Q` | Quit MixCode | Save state and exit safely |
| `Right` (empty input) | Toggle Extension Side Panel | Expand/collapse right-hand extension widget panel |
| `$` | Skill Autocomplete | Trigger available skill completion |
| `@` | File Autocomplete | Trigger workspace file path completion |
| `!` | Single-line Bash Command | Quick shell execution |

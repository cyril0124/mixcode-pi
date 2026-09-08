# MixCode Pi Architecture

[中文文档](architecture.zh.md)

MixCode is a multi-tab TUI agent built on top of Pi (`pi-tui` / `pi-agent-core` / `pi-ai`). This document records the layering, runtime mapping, keybindings, and commands of the current implementation.

## Overall Structure

```text
┌─────────────────────────┐
│ @earendil-works/pi-tui  │
│ Root + Editor + Overlay │
└────────────┬────────────┘
             │
             v
┌─────────────────────────┐
│ pi-agent-core Agent     │
│ SessionManager          │
│ AgentEvent stream       │
└────────────┬────────────┘
             │
             v
┌─────────────────────────┐
│ @earendil-works/pi-ai   │
│ Model + stream + tools  │
└─────────────────────────┘
```

## Module Layering

```text
src/
├── cli/
│   └── bootstrap.ts          Startup state, workspace, completion source
├── core/
│   ├── commands.ts           Local slash command parsing and completion sources
│   ├── tabs.ts               Tab creation, deletion, modification, and cycling
│   ├── overlays.ts           Pure state logic for tab jump, command palette, and overlay routing
│   ├── open-tabs-store.ts    open_tabs.json I/O and cross-instance tab set mutations
│   ├── batch-lua.ts          --batch plan collection (.lua via fengari) plus shared validate/apply
│   ├── batch-ts.ts           --batch plan collection for .ts/.mts/.js/.mjs script modules
│   ├── peer-tab-sync.ts      Cross-instance tab listener and reconciliation (open/close)
│   ├── state-store.ts        TUI state and workspace persistence
│   └── system-prompt.ts      Construct system prompt via Pi resource loader
├── agent/
│   ├── runtime.ts            MixCodeRuntime -> Pi Agent/Session
│   ├── tools.ts              Merge Pi built-in tools and extension tool owners with Tool Owners summary
│   └── faux-stream.ts        Echo faux model on the pi-ai faux provider core (tests, local demo)
└── ui/
    ├── app.ts                pi-tui Root, Editor, and global key handling
    ├── agent-tab-actions.ts  Tab lifecycle actions like openExistingAgentTab / closeExistingAgentTab
    ├── rendering.ts          Rendering for header/tab/status/panel/floating panel
    └── components/           Self-contained widgets and overlays (selectors, settings panel, extension manager, ...)
        └── completion.ts     Completion for / and @ ($skill completion provided by mpi-skill-refs extension)
```

## Runtime Mapping

`src/core/commands.ts` recognizes local commands registered in `LOCAL_COMMANDS`.
They take priority over extension commands and prompt templates. Pi's
`AgentSession.prompt()` handles other slash input in this order: extension command,
`input` event, skill/template expansion, user message. Extension commands and
input handlers can finish handling input without starting a model turn.

Unmatched slash input, such as `/home/example/session.jsonl` or `/unknown`,
becomes message text regardless of whether a file exists. The dispatcher trims
leading whitespace from slash input. Slash input forwarded to Pi retains
internal whitespace and newlines. Local handlers receive whitespace-normalized
`args` and unnormalized `rawArgs`; `/batch` parses `rawArgs` to preserve quoted
whitespace. Project context such as `AGENTS.md` is assembled in the system prompt.

```text
User Input
  │
  ├─ Registered /local-command
  │    └─ MixCode handler (UI, settings, or session operation)
  │
  ├─ Other input, including unknown slash input and paths
  │    └─ Pi AgentSession.prompt()
  │        ├─ Registered extension command -> execute
  │        └─ input event -> skill/template expansion -> user message
  │             └─ $skill references are handled by mpi-skill-refs
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
  └─ pi-ai Model           Resolves provider/modelId; faux provider streams via pi-ai createFauxCore
```

## UI and Keybindings

Authoritative key list and Escape dispatch: [Keybindings & Escape](keybindings-and-escape.md).
`Tab` / `Shift+Tab` cycle tabs only when autocomplete is closed and Zen mode is off.

```text
┌────────────────────────────────────────────────────────────┐
│ Header: MixCode                                            │
├────────────────────────────────────────────────────────────┤
│ [Home] [Agent-01] [Agent-02*]          Ctrl+T:Jump         │
├────────────────────────────────────────────────────────────┤
│ Status: Context / State / Model                            │
├────────────────────────────────────────────────────────────┤
│ Chat (user / assistant / tool / bash)                      │
│ optional: extension side panel on the right                │
├────────────────────────────────────────────────────────────┤
│ Shell overlay                                              │
├────────────────────────────────────────────────────────────┤
│ Prompt Editor (with / $ @ completion)                      │
└────────────────────────────────────────────────────────────┘
```

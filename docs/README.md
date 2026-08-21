# MixCode Pi Documentation

[中文文档](README.zh.md)

Documentation library for MixCode Pi, a multi-tab terminal AI coding agent built on [Pi](https://pi.dev).

## Architecture & Interface

- **[System Architecture](architecture.md)**: Overall layered structure, runtime event mapping, and global UI layout.
- **[TUI Component Catalog](tui-components.md)**: Full-screen frame layout, chrome elements, and component ownership boundaries.
- **[Narrow & Mobile Terminal Optimizations](narrow-terminals-and-mobile.md)**: Progressive UI degradation, compact tab overflows, and mobile touch/mouse interactions.
- **[Keybindings & Shortcuts](keybindings-and-escape.md)**: Core keyboard shortcuts, command palette, external editor, and Escape retraction.
- **[Mouse Support & Clickable Surfaces](mouse-support.md)**: SGR 1006 mouse protocol, clickable tabs/pickers, scrollbar drag, and text drag-copy.
- **[CLI & Flags](cli-and-flags.md)**: `mpi` options (`--workdir`, `--builtin-extensions-only`, `--batch`), `status` / `ctl` (Agent Tab collaboration), and delegation rules.

## Core Features & Workflows

- **[Built-in Extensions Overview](builtin-extensions.md)**: Catalog of first-party `mpi-*` extensions and runtime lifecycle (see individual packages under `pi-packages/` for dedicated READMEs).
- **[Zen Mode & Ambient Status](zen-mode.md)**: Distraction-free view, ambient background status dots, and seamless mode migration.
- **[Inline Widgets Mode (`[INL]`)](inline-widgets.md)**: Natural chat scroll integration for extension widgets and editor vertical space reclamation.
- **[Vim Navigation & Transcript Search](vim-and-navigation.md)**: Buffer navigation, user message jumping, and regex search.
- **[Workspace & Multi-Tab Sessions](workspace-and-tabs.md)**: Multi-tab workflows, `/reset` vs `/clear`, `/fork`, workspace layout persistence, and Agent Tab collaboration (`mpi ctl`).
- **[Steer & Follow-up Queue](queue-and-follow-up.md)**: Mid-turn prompt steering, next-turn follow-up queues, and `Ctrl+U` dequeue.
- **[Batch Lua Execution](batch-lua.md)**: Post-launch monorepo automation scripts, API reference, and dry-run validation.

## Configuration & Integration

- **[Slash Commands Reference](commands.md)**: Commands categorized by Global, Workdir, and Session persistence tiers.
- **[Settings (`mixcode_settings.json`)](mixcode-settings.md)**: User configuration schema, theme IDs, and provider/model disablement.
- **[Model Management & Routing](model-management.md)**: Provider setup, thinking tiers, and per-model dynamic skill/extension binding.
- **[Environment Variables](environment.md)**: Product-level `MIXCODE_*` variables and tool child process injection.
- **[Pi Extension Compatibility](extension-compatibility.md)**: Compatibility levels (L0–L3) and Pi ecosystem package discovery.
- **[Instance Registry & Status](instance-registry.md)**: `mpi status` monitoring and cross-process instance tracking.
- **[Extension UI & Widgets](extension-ui-and-widgets.md)**: 5-zone widget mounting and inline widget mode (`/toggle-inline-widgets`).

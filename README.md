# MixCode Pi

[中文文档](README.zh.md)

A **multi-tab**, terminal-native AI coding agent fully compatible with the [Pi](https://pi.dev) extension ecosystem.

> **Why MixCode Pi?**
> Standard AI coding agents lock your terminal to a single session — blocking you from exploring, reviewing, or running parallel tasks while the model is thinking. MixCode brings **native multi-tab concurrency** and **complete Pi extension compatibility** to the terminal: run multiple agents side by side, organize workspaces across restarts, and use the full Pi package catalog (`npm:…`, tools, widgets, and commands) with zero friction.

> **A note from the author**
> This is an AI-developed project. My daily development now happens entirely in mpi — including developing mpi itself. The code quality may be poor, but please experience mpi for yourself.

<p align="center">
  <img src="assets/readme-multi-tab.gif" alt="MixCode Pi multi-tab workspace" width="900">
</p>

## Highlights

- 🗂️ **Native Multi-Tab Concurrency**: Run multiple agent sessions simultaneously. Switch instantly with `Tab` / `Shift+Tab` or fuzzy jump via `Ctrl+T`. Background tasks show live status indicators (`●` running, `!` unread, `x` error).
- 🧩 **100% Pi Extension Compatible**: Works out-of-the-box with Pi packages (`settings.json` `packages`, npm extensions, custom tools, widgets, and themes). Ships with powerful first-party `mpi-*` extensions (Goal tracking, diff review, prompt optimization, auto-rename).
- 🧘 **Zen & Inline Modes**: Maximize editor space with Zen mode (`/toggle-zen-mode`) and ambient background status dots, or relocate widgets into the chat stream with Inline Widgets (`/toggle-inline-widgets`).
- 📱 **Mobile & Touch Optimized**: Engineered for narrow terminals, split panes, and mobile SSH emulators (Termux, iOS Blink) with touch-clickable tabs and pickers, and smooth progressive UI degradation.
- ⌨️ **Terminal-First Workflow**: Buffer-style Vim navigation (`j`/`k`, `Right`/`Shift+Right` user-turn jumps, `/` regex search), command palette (`Ctrl+P`), `$skill` autocompletion, and external editor delegation (`Ctrl+E`).
- 📜 **Declarative Batch Automation**: Script multi-agent workflows across monorepos via embedded Lua (`mpi --batch script.lua`) with dry-run plan validation.

---

## Quick start

Requires [Bun](https://bun.sh). Install globally from GitHub:

```bash
bun install -g github:cyril0124/mixcode-pi
mpi
```

Ensure `~/.bun/bin` is on your `PATH`. Upgrade with the same command; remove with `bun remove -g mixcode-pi`.

---

## Key Features

### 1. Multi-Tab Workspaces & Session Coordination
Run isolated agent sessions side-by-side. Each tab maintains an independent conversation tree, tool runtime, and working directory. Workspaces persist tab layouts across restarts, while atomic file locks (`open_tabs.json.lock`) coordinate tabs across multiple terminal windows or tmux panes.

<p align="center">
  <img src="assets/readme-multi-tab.gif" alt="Multi-tab sessions" width="900">
</p>

### 2. Full Pi Ecosystem & Built-in Extensions
Install community extensions directly through Pi package declarations (`npm:pi-web-access`) or use MixCode's first-party `mpi-*` tools:
- **`mpi-goal`**: Long-running goal tracking with dynamic progressive tool loading.
- **`mpi-diff-viewer`**: In-terminal visual diffs with line-level review comments (`/diff`).
- **`mpi-loop`**: Recurring prompt scheduling with conflict handling (`/loop 5m /review`).
- **`mpi-optimize-prompt`**: Metaprompt-based prompt expansion.

<p align="center">
  <img src="assets/readme-right-widget.gif" alt="Extension side panel" width="900">
</p>

### 3. Inline & Docked Extension Widgets
Switch dynamically between docked editor widgets and inline chat-stream widgets using `/toggle-inline-widgets`. In inline mode, widgets follow transcript scrolling rather than taking up fixed vertical editor space.

<p align="center">
  <img src="assets/readme-inline-widget.gif" alt="Inline widgets mode" width="900">
</p>

### 4. Vim Navigation & Transcript Search
Treat the conversation transcript as a Vim buffer: scroll line-by-line, jump between milestone user turns (`Right` / `Shift+Right`), and search with WeakMap-cached live regex (`/`). Enter via `/vim` or empty-queue `Ctrl+U` then `u`.

<p align="center">
  <img src="assets/readme-vim.gif" alt="Vim mode" width="900">
</p>

### 5. Zen Mode & Ambient Status
Hide the top tab bar for a completely distraction-free editing canvas. Background agents with notable state changes (running, waiting for input, error, done) are rendered as compact status dots (`●`) on the top border.

<p align="center">
  <img src="assets/readme-zen.gif" alt="Zen mode" width="900">
</p>

### 6. In-Prompt Skill References & Autocomplete
Type `$` in the prompt editor to trigger fuzzy autocomplete for project, global, and installed package skills, automatically embedding skill instructions into the prompt payload.

<p align="center">
  <img src="assets/readme-skill.gif" alt="Skill references" width="900">
</p>

### 7. Command Palette
Press `Ctrl+P` to fuzzy search and execute slash commands, model switches, and extension actions for the current tab context.

<p align="center">
  <img src="assets/readme-command-palette.gif" alt="Command palette" width="900">
</p>

---

## Keyboard shortcuts

Core keys (not the full map — open **Help** / Command Palette in-app for everything):

| Key | Scope | Action | Description |
|---|---|---|---|
| `Tab` / `Shift+Tab` | Global | Next / Previous Tab | Cycle tabs. No-op when autocomplete is open or Zen mode is on (use `Ctrl+T`). |
| `Ctrl+P` | Global | Command Palette | Fuzzy search and run slash commands. |
| `Ctrl+T` | Global | Tab Jump | Interactive modal to jump to any open tab. |
| `Ctrl+E` | Global | External Editor | Edit current draft in `$VISUAL` / `$EDITOR`. |
| `Ctrl+Q` | Global | Quit | Safely persists workspace state and exits. |
| `Ctrl+U` | Input / Queue | Dequeue / Vim | Pop queued message back to editor; empty queue arms Vim mode. |
| `Right` | Empty Input | Side Panel | Toggle right-hand extension widget panel. |
| `Escape` | Global | Smart Escape | Close overlay → exit Vim → abort/retract prompt. |
| `!` | Editor | Bash Command | Single-line shell execution mode. |
| `$` | Editor | Skill Autocomplete | Trigger project, global, and installed package skill completion. |
| `@` | Editor | File Autocomplete | Trigger workspace file path completion. |

---

## Installation

### From GitHub (recommended)

```bash
bun install -g github:cyril0124/mixcode-pi
mpi
```

Requires a **public** GitHub repo. Upgrade with the same command. Uninstall: `bun remove -g mixcode-pi`.

### From Local Checkout (Binary Build)

```bash
./install.sh                 # standalone binary → ~/.local/bin/mpi
./install.sh --prefix /opt/mixcode
bun run install:global       # global `mpi` linked from this repo
```

- `bun install -g github:…` — Runs via Bun runtime (`mpi`).
- `./install.sh` — Compiles into a single standalone binary (`bun build --compile`); requires no `node_modules` at runtime.

---

## Usage

```bash
mpi                             # Start in current directory
mpi --workdir ~/project         # Start in specific directory
mpi --builtin-extensions-only   # Disable 3rd-party packages; load only mpi-*
mpi --batch script.lua          # Run batch automation script
mpi status                      # Inspect running instances and tab states
```

---

## Documentation

Full architectural specifications, guides, and manuals are available in the [`docs/`](docs/README.md) directory:

- [System Architecture](docs/architecture.md)
- [TUI Components & Layout](docs/tui-components.md)
- [Multi-Tab Workspaces](docs/workspace-and-tabs.md)
- [Steering & Follow-up Queues](docs/queue-and-follow-up.md)
- [Zen Mode](docs/zen-mode.md)
- [Inline Widgets Mode](docs/inline-widgets.md)
- [Vim Mode & Navigation](docs/vim-and-navigation.md)
- [Batch Lua Automation](docs/batch-lua.md)
- [Pi Extension Compatibility](docs/extension-compatibility.md)
- [Slash Commands Reference](docs/commands.md)
- [MixCode Settings](docs/mixcode-settings.md)
- [Environment Variables](docs/environment.md)
- [Instance Registry & Monitoring](docs/instance-registry.md)

# MixCode Pi

[中文文档](README.zh.md)

A multi-tab, terminal-native AI coding agent built on [Pi](https://pi.dev).

**Pi extension compatible** — works with the Pi extension ecosystem (npm packages under `settings.json` `packages`, agent `extensions/`, widgets, tools, and slash commands). MixCode also ships first-party `mpi-*` built-ins. Use `--builtin-extensions-only` to load only those built-ins.

<p align="center">
  <img src="assets/readme-multi-tab.gif" alt="MixCode Pi multi-tab workspace" width="900">
</p>

## Quick start

Requires [Bun](https://bun.sh). Install globally from GitHub (no manual clone; **repo must be public**):

```bash
bun install -g github:cyril0124/mixcode-pi
mpi
```

Ensure `~/.bun/bin` is on your `PATH`. Upgrade with the same command; remove with `bun remove -g mixcode-pi`.

## Features

### Multi-tab sessions

Run several agent conversations side by side. Create tabs, cycle with `Tab` / `Shift+Tab`, or jump with `Ctrl+T`.

<p align="center">
  <img src="assets/readme-multi-tab.gif" alt="Multi-tab sessions" width="900">
</p>

### Vim mode

Scroll the chat like a buffer: enter Vim mode and jump between user messages without leaving the terminal.

<p align="center">
  <img src="assets/readme-vim.gif" alt="Vim mode" width="900">
</p>

### Zen mode

Hide the tab bar for a focused agent view. Tab jump (`Ctrl+T`) still works when you need another session.

<p align="center">
  <img src="assets/readme-zen.gif" alt="Zen mode" width="900">
</p>

### Command palette

`Ctrl+P` filters commands and slash actions for the current tab context.

<p align="center">
  <img src="assets/readme-command-palette.gif" alt="Command palette" width="900">
</p>

### Extension side panel

Press `Right` on an empty editor to open the extension widget panel (demo: task list via pi-tasks).

<p align="center">
  <img src="assets/readme-right-widget.gif" alt="Extension side panel" width="900">
</p>

### Skill references

Type `$` to attach project skills (demo skill: `list-open-todos` in `demo/readme-todo`).

<p align="center">
  <img src="assets/readme-skill.gif" alt="Skill references" width="900">
</p>

### Pi extensions

Compatible with [Pi](https://pi.dev) extensions: install via Pi package settings (`npm:…` / git packages), load from the agent extensions directory, and use tools, widgets, and commands the same way as in Pi.

## Keyboard shortcuts

Core keys (not the full map — open **Help** / Command Palette in-app for everything):

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Next / previous tab |
| `Ctrl+P` | Command palette |
| `Ctrl+T` | Tab jump |
| `Right` (empty input) | Toggle extension side panel / attach from Home |
| `Ctrl+Q` | Quit |
| `Escape` | Close overlay |
| `!` | Bash command |
| `$` | Skill autocomplete |
| `/toggle-zen-mode` | Zen mode |
| `/vim` or empty-queue `Ctrl+U` then `u` | Vim mode |
| `/new-session` / `/new-session Title` | New session (optional title) |

## Install

### From GitHub (recommended)

```bash
bun install -g github:cyril0124/mixcode-pi
mpi
```

Requires a **public** GitHub repo (private → API 404). Same command upgrades. Uninstall: `bun remove -g mixcode-pi`.

### From a local checkout

```bash
./install.sh                 # standalone binary → ~/.local/bin/mpi
./install.sh --prefix /opt/mixcode
bun run install:global       # global `mpi` from this tree
```

- `bun install -g github:…` — Bun runs the TypeScript entry (`mpi`); needs Bun on `PATH`.
- `./install.sh` — `bun build --compile` single binary; no `node_modules` at runtime.

**Development:** `bun install` (lockfile: `bun.lock`). Scripts use `bun run …` (e.g. `bun run check`).

## Usage

```bash
mpi                             # start in the current directory
mpi --workdir ~/project         # start in a specific directory
mpi --builtin-extensions-only   # load only MixCode built-in extensions
```

`--builtin-extensions-only` disables only third-party Pi extensions; skills, prompts, themes, and context files continue to load from the existing configuration.

## Configuration

Local MixCode settings live in workdir `mixcode_settings.json`. Pi-compatible packages, themes, skills, and auth use the usual Pi agent directory (`settings.json`, `packages`, etc.).

# CLI Entrypoint, Flags & Upstream Delegation

[中文文档](cli-and-flags.zh.md)

This document describes the CLI interface, command-line arguments, and Pi delegation rules implemented in `src/cli/main.ts`.

## Synopsis

```bash
mpi [options] [-- <script-args...>]
mpi status [--json] [--workdir <path>]
```

## Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `--workdir <path>` | string | Current working directory (`process.cwd()`) | Target working directory. Also accepts `--workdir=<path>`. There is no `-w` short flag. |
| `--builtin-extensions-only` | boolean | `false` | Disables third-party package discovery under `settings.json` `packages` and loads only first-party built-in extensions under `pi-packages/mpi-*`. |
| `--batch <script.lua>` | string | unset | Executes a Lua batch automation script after bootstrapping runtime. |
| `--batch-dry-run` | boolean | `false` | Validates model/thinking configurations and prints the batch execution plan without starting TUI or modifying state files. |
| `--help`, `-h` | boolean | `false` | Prints CLI usage text and exits immediately. |

## Status Subcommand

Inspects running MixCode instances and tab heartbeats across the machine:

```bash
mpi status
mpi status --json
mpi status --workdir /path/to/project
```

- `--json`: Outputs structured machine-readable JSON matching `InstanceStatusReport`.
- `--workdir <path>`: Filters status report to instances matching the specified workspace.

## Upstream Pi Delegation Rules

When argv contains `--print` or `-p`, MixCode delegates to the upstream `pi` binary on `$PATH` instead of launching the TUI:
- Environment variable `MIXCODE` is not set on delegated processes.
- Exit code from upstream `pi` is forwarded directly.

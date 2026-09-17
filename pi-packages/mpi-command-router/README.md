# mpi-command-router

[中文文档](README.zh.md)

`mpi-command-router` routes selected external Bash command names to a configured executable or script by prepending a private wrapper directory to `PATH` for that Bash call.

Routes come from two layers. Create `<agentDir>/mpi-command-router.json` for user-wide routes:

```json
{
  "$schema": "<agentDir>/extensions/mpi-command-router/mpi-command-router.schema.json",
  "routes": {
    "npm": ["$HOME/scripts/npm-router.sh"],
    "python": ["python3", "-u"]
  }
}
```

Optionally add `<cwd>/.pi/mpi-command-router.json` with the same shape for repository routes. A project file applies only in a trusted project, and its routes replace agent routes with the same command name.

The first array item is the target executable; the remaining items are fixed arguments, and the command's own arguments follow them. A bare target resolves through the original `PATH`. A target containing `/` resolves relative to the directory holding its config file, so project targets are relative to `<cwd>/.pi`. `$NAME` and `${NAME}` expand from the environment when the config is read. `$$` writes a literal dollar, so `$${X}` reaches the target as `${X}`; any other `${` form is rejected; an unset name blocks the call with an `Error:` message.

Pipes, redirects, heredocs, stdin, exit codes, and child shells stay with the original shell. Absolute command paths bypass routing because no `PATH` lookup happens.

A target can call the original executable through `$MPI_COMMAND_ROUTER_ORIGINAL`, and `$MPI_COMMAND_ROUTER_COMMAND` holds the routed name. Re-entering the same route exits 126 with `Error: recursive command route <name>; call "$MPI_COMMAND_ROUTER_ORIGINAL" to use the original executable.`

Each applicable config file is read before every Bash call, so edits apply to the next call. Routing runs only when every applicable file is enabled and valid; an invalid file blocks the call with an `Error:` message naming it.

`/command-router` reports the effective state of both layers. `/command-router off` and `/command-router on` write `enabled` into every applicable layer, `--global` or `--project` narrows a toggle to one layer, and a project layer without a config file is left untouched unless `--project` names it. A toggle keeps every route and `$schema` intact, refuses to overwrite an unreadable or invalid file with an `Error:` message, and names any layer that still blocks routing.

The bundled skill `skills/mpi-command-router/SKILL.md` is manual-only: load it with `$mpi-command-router` or `/skill:mpi-command-router`.

Generated wrappers live under `<agentDir>/cache/mpi-command-router/<hash>` and are kept, so a command already handed to a shell and any background job it started keep working. Only abandoned staging directories from an interrupted run are cleaned up.

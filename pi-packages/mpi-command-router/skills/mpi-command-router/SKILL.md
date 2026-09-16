---
name: mpi-command-router
description: Configure MixCode command routing so specific Bash command names run a configured command or script instead.
disable-model-invocation: true
---

# Command routing

`mpi-command-router` resolves selected command names to a configured executable. Every Bash call with at least one route gets a private wrapper directory at the front of `PATH`, so `deploy --tag v1` runs the route for `deploy` and appends `--tag v1`.

## Workflow

1. Read both config files: `<agentDir>/mpi-command-router.json` for user-wide routes, `<cwd>/.pi/mpi-command-router.json` for repository routes.
2. Ask which command names to route and what each should run. Put shared behavior in the agent config, repository behavior in the project config.
3. Write the config.
4. Verify with one Bash call that uses a routed name.

## Layers

Each applicable config file is read before every Bash call, so a saved edit applies to the next call.

- A missing file contributes no routes.
- Project routes apply only in a trusted project and replace agent routes with the same command name.
- Routing runs only when every applicable file is enabled.
- An invalid file blocks the call with an `Error:` message naming the file; an invalid project file is ignored while the project is untrusted.

## Config

```json
{
  "$schema": "<agentDir>/extensions/mpi-command-router/mpi-command-router.schema.json",
  "enabled": true,
  "routes": {
    "npm": ["$HOME/scripts/npm-router.sh", "--from-router"],
    "python": ["python3", "-u"]
  }
}
```

- `routes` maps a command name to a target plus fixed arguments. Keys beyond `$schema`, `enabled`, and `routes` are rejected.
- Names match `^[A-Za-z0-9_][A-Za-z0-9_.+-]*$`.
- `$NAME` and `${NAME}` expand from the environment when the config is read. `$$` writes a literal dollar, so `$${X}` reaches the target as `${X}`; any other `${` form rejects the config.
- A bare target resolves through the `PATH` seen before injection. A target containing `/` resolves relative to the directory holding its config file, so project targets are relative to `<cwd>/.pi`.
- Fixed arguments come first, then the arguments from the command line.
- `enabled: false` keeps the routes and stops injection.

A missing or non-executable target fails at run time with exit code 127 and `Error: command route <name>: executable not found or not executable: <path>`.

## Routed scripts

- `MPI_COMMAND_ROUTER_ORIGINAL`: absolute path of the original executable, empty when none exists on `PATH`.
- `MPI_COMMAND_ROUTER_COMMAND`: the routed name.
- `MPI_COMMAND_ROUTER_ACTIVE`: colon-separated names already routed in this process tree.
- `MPI_COMMAND_ROUTER_BASE_PATH`: `PATH` as it was before injection.

Call `"$MPI_COMMAND_ROUTER_ORIGINAL"` to keep the original behavior. Executing the routed name again inside its own target exits 126 with `Error: recursive command route <name>; call "$MPI_COMMAND_ROUTER_ORIGINAL" to use the original executable.`

## Limits

- Absolute-path invocations, shell functions, and aliases bypass routing.
- Pipes, redirections, heredocs, and child shells keep their normal meaning.
- The rewrite applies to the Bash tool only.

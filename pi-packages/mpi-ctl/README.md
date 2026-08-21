# mpi-ctl

Agent Tab collaboration skill (`pi.skills: ["./skills"]`).

An agent tab uses `mpi status` / `mpi ctl` to prompt, wait on, and read peer tabs in this TUI or another `mpi`. Those subcommands live on the `mpi` binary; this package does not add a second CLI.

Pi loads `pi.skills` when the package is installed normally. When MixCode installs the built-in package under `<agentDir>/extensions/`, `index.ts` contributes the same `skills/` tree through `resources_discover`; `$` completion scans that package tree directly. No package skill is copied into `<agentDir>/skills`.

Cookbook: [skills/mpi-ctl/SKILL.md](skills/mpi-ctl/SKILL.md).

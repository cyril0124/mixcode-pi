# mpi-ctl

Pi package that ships the `mpi-ctl` skill (`pi.skills: ["./skills"]`).

Pi loads `pi.skills` when the package is installed normally. When MixCode installs the built-in package under `<agentDir>/extensions/`, `index.ts` contributes the same `skills/` tree through `resources_discover`; `$` completion scans that package tree directly. No package skill is copied into `<agentDir>/skills`.

No extra CLI. Cookbook: [skills/mpi-ctl/SKILL.md](skills/mpi-ctl/SKILL.md).

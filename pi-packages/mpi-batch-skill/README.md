# mpi-batch-skill

[中文](README.zh.md)

Manual-only skill for writing, validating, and launching MixCode batch scripts. Invoke `$mpi-batch <task>` in MixCode or `/skill:mpi-batch <task>` through Pi's skill commands.

`disable-model-invocation: true` hides the skill from the model's system-prompt skill list while allowing explicit user invocation. It does not restrict file access. The skill writes and validates scripts by default, and launches them only when requested.

Pi discovers the skill through `pi.skills`. MixCode installs it under `<agentDir>/extensions/mpi-batch-skill/`, where `index.ts` contributes the `skills/` directory through `resources_discover`.

[SKILL.md](skills/mpi-batch/SKILL.md) contains the workflow, CLI commands, examples, and execution limits. Its [TypeScript](skills/mpi-batch/references/mixcode-batch.d.ts) and [Lua](skills/mpi-batch/references/mixcode.lua) references own the API declarations. Both ship with the package and compiled binary. Validation and execution require `mpi` on `PATH`.

In a source checkout, root `mixcode-batch.d.ts` and `mixcode.lua` are relative symlinks to these references. Edit the reference files to update the declarations. Windows Git checkouts need symlink support enabled.

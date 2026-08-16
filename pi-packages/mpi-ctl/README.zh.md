# mpi-ctl

Pi 包，提供 `mpi-ctl` skill（`pi.skills: ["./skills"]`）。

正常安装 Pi package 时由 `pi.skills` 加载 skill。MixCode 把内置包安装到 `<agentDir>/extensions/` 时，`index.ts` 通过 `resources_discover` 提供同一个 `skills/` 目录；`$` 补全直接扫描该包目录。Package skill 不会复制到 `<agentDir>/skills`。

不新增 CLI。手册：[skills/mpi-ctl/SKILL.md](skills/mpi-ctl/SKILL.md)。

# mpi-ctl

Agent Tab 协作 skill（`pi.skills: ["./skills"]`）。

Agent Tab 用 `mpi status` / `mpi ctl` 向本 TUI 或其他 `mpi` 的同伴 Tab 发 Prompt、等待、读结果。这两个子命令在 `mpi` 二进制上，本包不另加 CLI。

正常安装 Pi package 时由 `pi.skills` 加载 skill。MixCode 把内置包安装到 `<agentDir>/extensions/` 时，`index.ts` 通过 `resources_discover` 提供同一个 `skills/` 目录；`$` 补全直接扫描该包目录。Package skill 不会复制到 `<agentDir>/skills`。

手册：[skills/mpi-ctl/SKILL.md](skills/mpi-ctl/SKILL.md)。

# mpi-command-router

[English](README.md)

`mpi-command-router` 通过在该次 Bash 调用前把私有 wrapper 目录放到 `PATH` 最前面，把指定的外部命令名路由到配置的命令或脚本。

路由来自两层。用户级配置写在 `<agentDir>/mpi-command-router.json`：

```json
{
  "$schema": "<agentDir>/extensions/mpi-command-router/mpi-command-router.schema.json",
  "routes": {
    "npm": ["$HOME/scripts/npm-router.sh"],
    "python": ["python3", "-u"]
  }
}
```

仓库级路由可选地写在 `<cwd>/.pi/mpi-command-router.json`，格式相同。项目配置仅在项目受信任时生效，同名路由会覆盖 agent 配置中的定义。

数组第一项是目标可执行文件，后续项是固定参数，命令自身的参数追加在其后。目标写成裸名称时使用原始 `PATH` 查找；目标含 `/` 时相对于它所属配置文件的目录解析，因此项目中的目标是相对于 `<cwd>/.pi`。读取配置时 `$NAME` 与 `${NAME}` 展开为环境变量。`$$` 表示字面量美元符，因此 `$${X}` 会以 `${X}` 传给目标；其他 `${` 形式一律拒绝；环境变量未设置则阻止调用并返回 `Error:` 消息。

管道、重定向、heredoc、标准输入、退出码和子 Shell 仍由原 Shell 处理。绝对路径调用不经过 `PATH` 查找，因此不会被路由。

目标脚本可通过 `$MPI_COMMAND_ROUTER_ORIGINAL` 调用原命令，`$MPI_COMMAND_ROUTER_COMMAND` 是被路由的命令名。再次进入同一路由会以 126 退出并打印 `Error: recursive command route <name>; call "$MPI_COMMAND_ROUTER_ORIGINAL" to use the original executable.`

每个适用的配置文件都在每次 Bash 调用前读取，编辑后下一次调用生效。只有所有适用的配置文件都启用且合法时才注入；非法文件会阻止调用并返回带文件路径的 `Error:` 消息。

包内置的 skill `skills/mpi-command-router/SKILL.md` 仅手动加载：用 `$mpi-command-router` 或 `/skill:mpi-command-router`。

生成的 wrapper 位于 `<agentDir>/cache/mpi-command-router/<hash>`，会被保留，使已经交给 Shell 的命令以及它启动的后台任务继续可用。只有中断运行留下的 staging 目录会被清理。

# CLI 入口、参数选项与上游委托 (CLI & Flags)

[English Documentation](cli-and-flags.md)

本文档记录 `src/cli/main.ts` 中实现的 CLI 命令行接口、参数选项及上游 Pi 委托规则。

## 命令用法概要

```bash
mpi [options] [-- <script-args...>]
mpi status [--json] [--workdir <path>]
```

## 选项参数清单

| 参数 | 类型 | 默认值 | 作用说明 |
|---|---|---|---|
| `--workdir <path>` | string | 当前工作目录 (`process.cwd()`) | 指定工作目录。也接受 `--workdir=<path>`。没有 `-w` 短选项。 |
| `--builtin-extensions-only` | boolean | `false` | 禁用 `settings.json` `packages` 中配置的第三方扩展，仅加载 `pi-packages/mpi-*` 下的第一方内置扩展。 |
| `--batch <script.lua>` | string | 未设置 | 启动运行时后执行指定的 Lua 批量自动化脚本。 |
| `--batch-dry-run` | boolean | `false` | 仅校验模型与思考配置并打印批量执行计划，不启动 TUI，不写入任何状态文件。 |
| `--help`, `-h` | boolean | `false` | 打印命令行帮助文本并立即退出。 |

## `status` 子命令

检视机器上所有正在运行的 MixCode 实例与 Tab 运行状态：

```bash
mpi status
mpi status --json
mpi status --workdir /path/to/project
```

- `--json`：输出与表格字段一致的机器可读 JSON（`pid`、`workdir`、`activeTabTitle`、tabs）。
- `--workdir <path>`：仅保留实例根 workdir 与解析后路径完全相等的进程。相对路径相对当前工作目录解析。`~` 与 `~/...` 展开为家目录。也接受 `--workdir=<path>`。
- `status` 命令运行在独立的轻量路径上，直接读取实例注册表，不启动 TUI、不导入 Pi 运行时组件，编译版亦不释放二进制资产。

## 上游 Pi 自动委托机制

仅当参数包含 `--print` 或 `-p` 时，MixCode 会把调用转给 `$PATH` 上的上游 `pi`：
- 委托进程中不会设置 `MIXCODE` 环境变量。
- 完整透传参数与退出码（Exit Code）。

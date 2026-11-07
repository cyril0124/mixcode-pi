# MixCode Pi (`mpi`)

[English](README.md)

MixCode 直接使用 [Pi fork](vendor/pi) 作为 CLI 与交互宿主。当前仓库负责单文件二进制的构建、安装，以及 [`pi-packages/`](pi-packages/) 中的 19 个内置扩展。Git 子模块锁定 fork 提交；仓库不再维护另一套宿主实现或 Pi 包补丁。

## 核心亮点

- **只安装一个可执行文件。** `install.sh` 仅在所选 `bin/` 安装一个可执行文件（默认名为 `mpi`）；Bun、Node/npm 只在构建时需要。
- **直接使用 fork 的多标签工作区。** Tab、会话、主题和批处理由固定版本的 fork 提供，不再运行另一套 UI。
- **内置扩展。** 单文件内嵌 19 个 `mpi-*` 包、技能以及 fork 所需的文档、示例和运行资源。
- **嵌套工具调用转录。** `/transcript chatlog` 显示 `codemode` 等工具内部已记录的调用。[详情](pi-packages/mpi-transcript/README.zh.md#嵌套工具调用)。

## 安装

在包含 `vendor/pi` 子模块的当前检出中运行：

```sh
git submodule update --init vendor/pi
./install.sh
~/.local/bin/mpi
```

可用 `./install.sh --prefix /自定义目录` 安装到 `/自定义目录/bin/mpi`；加上 `--name custom-mpi` 则安装到 `/自定义目录/bin/custom-mpi`。该选项只更改文件名，不更改程序内部的 `mpi` 标识。构建需要 Bun、Node.js >= 22.19 和 npm。每次构建 fork 都需联网刷新模型目录，刷新失败则停止构建。装好的二进制不依赖源码目录，也不用在旁边放资源文件。Linux 启动时将运行资源解包到 `$XDG_CACHE_HOME/mpi/tmp/mixcode-pi-*`（未设置或不是绝对路径时默认 `~/.cache/mpi/tmp/mixcode-pi-*`），正常退出会删除本次随机子目录；macOS 和 Windows 仍使用系统临时目录。内置扩展与 fork 专用文档分别保存在 Pi agent 目录（`PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）下的 `extensions/` 和 `mixcode-docs/`；coding-agent 文档及示例只解包到每次启动的运行目录，退出后清理。

## 本地开发

```sh
git submodule update --init vendor/pi
./run.sh
```

`run.sh` 在输入变更后构建 fork 并重编本地二进制。开发运行和安装仅在 fork 锁文件校验和与上次成功安装一致时复用依赖。`bun run check` 执行构建、类型检查、Lint、扩展测试。`release.sh` 生成指定平台的单文件可执行程序。更新 Pi 时，先更新 fork 仓库，再更新这里锁定的子模块提交，不再修补当前仓库中的 registry 包。

## 功能与资料

- [fork 的功能与命令](vendor/pi/docs/README.zh.md)说明实际宿主行为。
- [内置扩展](pi-packages/)各自带包清单，并按需提供 README 和 Skill 说明。

旧宿主实现可从 `master` 分支的 Git 历史中查阅，但不再位于此分支的运行目录。

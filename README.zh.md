# MixCode Pi

终端原生的 AI 编程助手。

<p align="center">
  <img src="assets/screenshot.png" alt="MixCode Pi TUI" width="800">
</p>

## 特性

- **多 Tab 会话** — 并行运行多个 agent 对话，自由切换
- **Agent View** — 实时观察 agent 的工作状态，随时发送消息干预
- **Pi 扩展兼容** — 开箱即用，完整支持 Pi 扩展生态

## 安装

需要预先安装 [Bun](https://bun.sh)：

```bash
./install.sh              # 默认安装到 ~/.local/bin/mixcode-pi
./install.sh --prefix /opt/mixcode  # 自定义安装路径
```

通过 `bun build --compile` 编译为独立的单二进制文件，运行时无需 Node.js 或 node_modules。

## 使用

```bash
mixcode-pi                             # 在当前目录启动
mixcode-pi --workdir ~/project         # 指定工作目录
mixcode-pi --builtin-extensions-only   # 仅加载 MixCode 内置扩展
```

`--builtin-extensions-only` 只关闭第三方 Pi extensions；skills、prompts、themes 和上下文文件仍按现有配置加载。

## 配置

支持的本地设置见 [`mixcode_settings.json`](docs/mixcode-settings.md)。

批量任务脚本见 [`docs/batch-lua.md`](docs/batch-lua.md)。

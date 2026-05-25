# MixCode Pi

`mixcode-pi` 是基于 Pi 体系重构的 MixCode TUI。它以原 MixCode 的 TUI 体验作为功能、快捷键、交互流程和视觉参考，运行时使用远程 Pi npm packages。

核心映射：

```text
legacy MixCode runtime
        |
        v
mixcode-pi
  TypeScript + @earendil-works/pi-tui
  session/workspace -> @earendil-works/pi-coding-agent SessionManager + pi-agent-core Agent
  provider/stream/tool -> @earendil-works/pi-ai + Agent tool events
```

## 开发命令

```bash
npm install
npm run check
npm run build
node dist/cli/main.js
```

## 单二进制安装

需要预先安装 [bun](https://bun.sh)：

```bash
./install.sh              # 默认安装到 ~/.local/bin/mixcode-pi
./install.sh --prefix /opt/mixcode  # 安装到 /opt/mixcode/bin/mixcode-pi
```

此方式会通过 `bun build --compile` 编译出一个独立的可执行文件，无需 Node.js 或 node_modules。

`npm run coverage` 会强制 lines/functions/statements 达到 95%，branches 达到 90%。

真实 TUI smoke 默认跳过；需要 tmux 和真实终端会话时可显式开启：

```bash
MIXCODE_RUN_TMUX_TUI_SMOKE=1 node --test --import tsx test/tui-smoke.test.ts
```

该 smoke 会用 180x48 tmux 启动 `./run.sh`，检查 MixCode 初始画面、OpenCode 反残留、`/theme li` light palette 和 `Ctrl+Q` 退出。

## Pi Packages

项目级 Pi package 配置放在 `.pi/settings.json`。用户可以自行安装需要的 Pi packages：

```json
{
  "packages": ["npm:<package-name>"]
}
```

Pi resource loader 会按该配置安装并发现 remote package；安装缓存位于 `.pi/npm/`，属于可再生产物，不进入版本控制。MixCode 只维护通用 Pi extension 兼容层，不内置特定 package 的专用逻辑。

## 技术方案

迁移结构、pi 运行时映射、快捷键和验收策略见 [docs/architecture.md](docs/architecture.md)。

Pi package / extension 兼容性说明见 [docs/extension-compatibility.md](docs/extension-compatibility.md)。

逐项验收证据和剩余边界见 [docs/completion-audit.md](docs/completion-audit.md)。

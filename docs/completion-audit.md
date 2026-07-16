# MixCode Pi 验收审计

本文把原始目标拆成可验证交付项，并记录当前仓库里的证据。它不是“完成宣言”；任何标为缺口或弱验证的项目，都应继续用真实代码、测试、日志或 TUI 截图补强。

## 目标拆解

```text
MixCode Pi
  │
  ├─ 语言与依赖
  │   ├─ TypeScript
  │   ├─ @earendil-works/pi-tui
  │   ├─ @earendil-works/pi-agent-core
  │   └─ @earendil-works/pi-ai
  │
  ├─ 运行时
  │   ├─ 无 opencode server
  │   ├─ Pi AgentSession / SessionManager
  │   ├─ Pi model registry / OpenAI Responses
  │   └─ Pi extension / package 兼容
  │
  ├─ TUI
  │   ├─ 参考 refs/mixcode 的布局、快捷键、鼠标流
  │   ├─ 移除 OpenCode 专有 UI
  │   ├─ thinking/chat 参考 Pi agent / oh-my-pi 方向
  │   └─ 视觉风格接近 MixCode
  │
  └─ 验证
      ├─ 自动化测试
      ├─ 真实 tmux TUI 截图
      ├─ Pi extension/package compatibility tests
      └─ 文档化差异和限制
```

## 证据矩阵

| 要求 | 当前证据 | 状态 |
| --- | --- | --- |
| 使用 TypeScript | `package.json` 为 `"type": "module"`；源码在 `src/**/*.ts`；`timeout 60s npm run build` 已通过。 | 已验证 |
| TUI 基于 `@earendil-works/pi-tui` | `package.json` dependency；`src/ui/app.ts` 使用 `TUI`、`Editor`、`ProcessTerminal`；`test/runtime-ui.test.ts` 和 `test/tui-fixed-header.test.ts` 覆盖 render/input。 | 已验证 |
| Agent 运行时基于 `pi-agent-core` | `src/agent/runtime.ts` 使用 `Agent`；`src/agent/tools.ts` 使用 `AgentTool`；runtime tests 覆盖 session、stream、abort、queue。 | 已验证 |
| LLM/provider/stream/tool 基于 `pi-ai` | `src/core/pi-models.ts` 使用 `streamSimple`、`ModelRegistry`；`src/agent/faux-stream.ts` 和 runtime tests 覆盖 streaming/tool call。 | 已验证 |
| 不依赖 opencode server | `package.json` 只有 Pi 相关 runtime dependencies；TUI smoke 检查初始画面不含 `OpenCode / Attach Session / Connect / Reconnect`；`test/overlays.test.ts` 有反残留断言。 | 已验证 |
| `refs/mixcode` 只作参考 | `.gitignore` 忽略 `refs/`；docs 明确 `refs/` 只用于 UI/交互参考；运行代码未依赖 `refs/`。 | 已验证 |
| 移除 OpenCode 专有组件 | Config render 测试断言不包含 `Connect/Reconnect/Attach Session/opencode`；真实 TUI smoke 同样检查。 | 已验证 |
| 主要快捷键和交互 | `docs/architecture.md` 列出全局和局部作用域快捷键；`src/core/keymap.ts` 提供 scoped keymap；`test/runtime-rendering-07.test.ts` 断言 `picker/command-palette/tab-jump/preview` 作用域存在；`!`/`!!` 走 Pi `executeBash`（非独立 shell overlay），`test/shell-pi-parity.test.ts` 覆盖并发 bash 恢复、Esc 取消提示与 pending bash 显示；相关 UI 测试覆盖 tab、palette、queue Esc、Ctrl+Q、@ picker、preview。 | 已验证 |
| 鼠标行为 | `src/core/mouse.ts`、`src/ui/app.ts` 覆盖 SGR 鼠标；测试覆盖 tab bar 点击、Config action hit region、input meta hit region、preview/chat wheel。 | 已验证 |
| 自动化测试可运行 | `timeout 60s npm run test` 可运行。 | 已验证 |
| docs 文件夹中文技术方案和 ASCII 图 | `docs/architecture.md`、`docs/extension-compatibility.md`、本文均为中文并包含 ASCII 结构图。 | 已验证 |
| 真实 TUI 截图/交互验证 | `tmp/ref-mixcode-160x48.*`、`tmp/mixcode-pi-*.txt/.ansi`、`tmp/tui-verify-*` 记录参考和当前 TUI 截图；`test/tui-smoke.test.ts` 可重复验证 180x48 tmux 启动、标题、OpenCode 反残留、`/thinking` picker 显示并应用模型支持的 `max`、`/settings` 主题切换、command palette、tab jump、`@` file picker、preview、`!` bash-mode、新建 tab、mouse tab click 和 Ctrl+Q 退出。 | 已验证 |
| 视觉风格接近 MixCode | `src/ui/themes.ts` 提供 MixCode dark/claude-warm/tokyo-night/terminal；render tests 断言 dark/claude-warm/tokyo-night palette；tmux 截图文件保存 160x48 对照。 | 强验证但仍需人工审美复核 |
| thinking/chat 不照搬 MixCode | `src/ui/rendering.ts` 对 thinking/tool/chat 有独立渲染；runtime tests 覆盖 thinking stream、tool block、renderer。 | 已验证 |
| 自定义 proxy 模型 OpenAI Responses | 本机 precheck 显示本地配置的 responses 模型 `registered=true auth=true api=openai-responses`；模型注册测试覆盖 OpenAI Responses 配置读取；本轮真实请求 smoke 返回 `MIXCODE_RESPONSES_SMOKE_OK`。 | 已验证 |
| Pi extension 兼容 | `PI_EXTENSION_COMPAT_PLAN.md` 和 `docs/extension-compatibility.md` 记录；runtime tests 覆盖 extension factories、tools、commands、UI primitives、renderers、theme、shortcuts、terminal input 和 package resource discovery。 | 已验证通用兼容层 |
| Theme 切换 | `/settings` 面板主题项、extension `ctx.ui.setTheme("tokyo-night")` 均有测试；tmux 180x48 经 `/settings` 选择 tokyo-night 确认 palette。 | 已验证 |
| Pi `ctx.ui.custom()` 默认非 overlay | `src/agent/runtime.ts` 将默认 `ctx.ui.custom()` 映射为临时 editor replacement；`test/runtime-ui.test.ts` 覆盖渲染、键盘输入、`done()` 恢复默认 editor；overlay 模式仍由独立测试覆盖。 | 已验证 |

## 最近实际命令

```text
timeout 60s npm run typecheck
timeout 60s npm run build
timeout 60s npm run test

MIXCODE_RESPONSES_SMOKE_MODEL=<provider>/<model-id> \
  timeout 120s node --test --import tsx test/models-question.test.ts \
  --test-name-pattern "configured proxy model sends a real OpenAI Responses request"

MIXCODE_RUN_TMUX_TUI_SMOKE=1 \
  timeout 60s node --test --import tsx test/tui-smoke.test.ts
```

已观察到的关键结果：

```text
test:
  tests = 219
  pass = 215
  skipped = 4

responses smoke:
  api: openai-responses
  provider/model: 取自本地 MIXCODE_RESPONSES_SMOKE_MODEL，不入库
  pass: assistant replied MIXCODE_RESPONSES_SMOKE_OK

tmux TUI smoke:
  viewport: 180x48
  pass: starts, rejects OpenCode UI, shows model-supported max thinking and applies /thinking max
  pass: switches theme via /settings to tokyo-night palette
  pass: opens command palette, tab jump, @ file picker, preview, bang bash-mode
  pass: creates a second tab, switches tab by SGR mouse click, exits with Ctrl+Q
```

## TUI 截图证据

```text
tmp/
  ├─ ref-mixcode-160x48.txt
  ├─ mixcode-ref-input-current.txt
  ├─ mixcode-pi-input-codex-final-160x48.txt
  ├─ mixcode-pi-workdir-completed-160x48.txt
  ├─ mixcode-pi-extension-ui-160x48.txt
  ├─ mixcode-pi-multitab-160x48.txt
  ├─ mixcode-working-spacing-fixed-180x48.txt
  ├─ mixcode-agent-bottom-fixed-180x48.txt
  └─ tui-verify-20260510-config.txt
```

这些文件是人工视觉复核的输入，不应当当作自动通过信号。每次大改 TUI 后至少重新跑一次 tmux 大尺寸截图，并对照 `ref-mixcode-160x48.txt`。

最新 spacing 复核：

```text
tmp/mixcode-working-spacing-fixed-180x48.txt
  line 5   user message
  line 6   blank
  line 7   Working (...)
  line 8   input prompt
  line 10  model / thinking / workdir meta

tmp/mixcode-agent-bottom-fixed-180x48.txt
  line 46  input prompt
  line 47  blank
  line 48  model / thinking / workdir meta
  no trailing blank row below meta
```

## 已知边界

```text
不是 100% 等价的点
  │
  ├─ Textual hover 事件：pi-tui 当前事件层不同，不做假 hover 复刻。
  ├─ Footer 快捷键提示：用户明确要求输入区下方 help 快捷键信息去掉；因此不恢复 refs/mixcode 的完整快捷键 footer。
  └─ 所有 Pi package catalog：只验证通用 extension 兼容层，具体 package 由用户自行安装和验收。
```

## 下次迭代优先级

```text
1. 改 TUI 后先跑 160x48 tmux 截图，不只看静态 render。
2. 改 runtime/extension 后先跑 targeted runtime-ui，再按需用用户安装的 package 做真实 smoke。
3. 改 model/provider 后验证本地配置的 responses 模型仍是 openai-responses。
4. 不为了过测试添加 fallback/mock success；失败应显式暴露。
```

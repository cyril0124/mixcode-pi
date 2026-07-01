# MixCode Pi 技术方案

本文记录 MixCode TUI 体验到 `mixcode-pi` 的迁移方案。目标是把相同的 TUI 体验映射到 Pi 的 TUI、Agent、AI 三层模型上，运行时使用远程 Pi npm packages。

## 总体结构

```text
legacy MixCode TUI                   mixcode-pi
Python + Textual                     TypeScript
legacy mediated runtime              Pi packages

┌────────────────────┐               ┌────────────────────────┐
│ Textual App         │               │ @earendil-works/pi-tui │
│ tabs / overlays     │──────────────>│ Root + Editor + Overlay │
└─────────┬──────────┘               └────────────┬───────────┘
          │                                       │
          v                                       v
┌────────────────────┐               ┌────────────────────────┐
│ session commands    │               │ pi-agent-core Agent     │
│ runtime events      │──────────────>│ SessionManager          │
│ tool events         │               │ AgentEvent stream       │
└─────────┬──────────┘               └────────────┬───────────┘
          │                                       │
          v                                       v
┌────────────────────┐               ┌────────────────────────┐
│ provider / tools    │               │ @earendil-works/pi-ai   │
│ legacy mediated     │──────────────>│ Model + stream + tools   │
└────────────────────┘               └────────────────────────┘
```

## 模块分层

```text
src/
├── cli/
│   └── bootstrap.ts          启动状态、workspace、completion source
├── core/
│   ├── commands.ts           本地 slash command 解析与补全源
│   ├── tabs.ts               tab 增删改与前后环绕切换
│   ├── overlays.ts           preview、tab jump、shell 等纯状态逻辑
│   ├── questions.ts          question UI 的选择/提交模型
│   ├── state-store.ts        TUI 状态与 workspace 持久化
│   └── system-prompt.ts        通过 Pi resource loader 构建 system prompt
├── agent/
│   ├── runtime.ts            MixCodeRuntime -> pi Agent/Session
│   ├── tools.ts              Pi built-in tools、extension tool owner 合并与 Tool Owners 摘要
│   └── faux-stream.ts        测试和本地演示用 faux model stream
└── ui/
    ├── app.ts                pi-tui Root、Editor、全局键处理
    ├── rendering.ts          类 MixCode 的 header/tab/status/panel 渲染
    └── completion.ts         /、$、@ 三类补全
```

## 运行时映射

```text
用户输入
  │
  ├─ 普通 prompt
  │    └─ buildModelPrompt()
  │        ├─ 用户文本
  │        ├─ $skill 引用
  │        ├─ @file 引用
  │        └─ 不注入 AGENTS.md；项目上下文进入 system prompt
  │
  ├─ /local-command
  │    ├─ 纯 UI 状态：/toggle-todo /preview /shell /mark-done
  │    ├─ 会话操作：/new-session /fork /compact /delete-session
  │    └─ prompt 模板：/goal /compact
  │
  └─ !shell
       └─ 作为 shell 请求进入 Agent，同时写入 preview shell 消息

MixCodeRuntime
  │
  ├─ SessionManager        保存/恢复/分叉/清空替换/删除 session
  ├─ prompt history        getPromptHistory() 读取当前 SDK branch 的 user prompt；workspace restore 后回灌 tab.promptHistory
  ├─ Agent                 执行 prompt 和工具
  ├─ AgentEvent            映射为 tab status、chat、todos、questions、goal
  └─ pi-ai Model           provider/modelId 解析，faux provider 用本地 stream
```

## UI 和快捷键

当前实现把原项目的主要全局绑定映射为 pi-tui 输入监听。`Tab` 与 `Shift+Tab` 只有在 Editor 补全没有打开时才切换标签，避免抢走 `/`、`$`、`@` 补全的接受候选行为。

```text
┌────────────────────────────────────────────────────────────┐
│ Header: MixCode                                            │
├────────────────────────────────────────────────────────────┤
│ [Config] [Agent-01] [Agent-02*]        Ctrl+T:Jump         │
├────────────────────────────────────────────────────────────┤
│ Status: Context / State / Model                            │
├──────────────────────────────┬─────────────────────────────┤
│ Chat                         │ TODO Board                  │
│ user / assistant / tool      │ optional                    │
├──────────────────────────────┴─────────────────────────────┤
│ Shell / Markdown Preview overlays                           │
├────────────────────────────────────────────────────────────┤
│ > prompt editor                                             │
├────────────────────────────────────────────────────────────┤
│ status meta: model / thinking / workdir / git branch        │
└────────────────────────────────────────────────────────────┘
```

Config tab 只渲染配置面板和可点击操作，不渲染 prompt editor；这是为了避免在配置页出现无效的 Input Message 输入框。输入区下方不保留 refs/mixcode 的完整快捷键 footer，快捷键信息集中放在 help overlay 中。

| 快捷键 | 当前行为 |
| --- | --- |
| `Tab` | 下一个 tab，补全打开时交给 Editor 接受候选 |
| `Shift+Tab` | 上一个 tab，补全打开时不抢占 |
| `r` | config tab 或 overlay 场景从 pi runtime 刷新 tab 状态；agent 输入中保留普通字符 |
| `Ctrl+P` | 可过滤命令面板；按 Config/Agent tab 显示当前语境命令，回车执行可用命令 |
| `Ctrl+T` | tab jump 模糊跳转；打开后 `Tab`/`Shift+Tab` 在候选中移动，不穿透到全局 tab 切换 |
| `Ctrl+E` | 外部编辑器编辑输入 |
| `Ctrl+C` | 清空普通编辑输入；shell 打开时发送中断给 shell |
| `Ctrl+J` / `Shift+Enter` | 在当前 Editor 光标处插入换行 |
| `Ctrl+R` | 预填 `/rename 当前标题`，复用 slash command 重命名 |
| `Alt+Up` / `Ctrl+U` | 将最后一条 queued prompt 弹回编辑器；没有队列时不抢占 Editor |
| `Up` / `Down` | 普通输入为空且无 overlay、preview、补全、extension terminal input 消费时浏览当前 tab 的 prompt 历史；其它场景交给局部控件 |
| `Right` | 普通输入为空且无 overlay、preview、补全、extension user interaction 时切换 extension widget side panel；无 widget 或终端过窄时显示 toast；有输入时交给 Editor 光标移动 |
| `Ctrl+V` | Markdown preview |
| `@` | 打开 mixcode 风格全局文件 picker，选择后插入 `@path ` |
| `Esc` | 关闭 overlay、preview 或 tab jump；shell 场景单次关闭 shell |
| `Ctrl+Q` | 打开退出确认；`y` 确认、`n`/`Esc` 取消；`/quit` 和 `/exit` 直接退出，不弹确认 |
| `q` | 普通输入字符，不绑定退出，避免破坏 prompt 输入 |

`src/core/keymap.ts` 是带作用域的可审计 keymap，不只记录全局键。`global` 作用域覆盖主输入表面，`file-picker`、`picker`、`command-palette`、`tab-jump`、`export`、`preview`、`shell` 作用域覆盖 overlay 或局部交互；`describeKeymap()` 保持旧的简短输出，`describeScopedKeymap()` 用于审计完整局部键表。

```text
key input
  │
  ├─ global
  │    ├─ Tab / Shift+Tab / Ctrl+P / Ctrl+T
  │    ├─ Ctrl+E / Ctrl+C / Ctrl+R / Ctrl+V / Ctrl+Q
  │    └─ @ / Esc / Alt+Up / Ctrl+U / Up / Down / Right
  │
  └─ scoped overlays
       ├─ picker:          Tab Shift+Tab Up Down Enter Esc
       ├─ file-picker:     Tab Ctrl+G j/k g/G Enter Esc
       ├─ command-palette: Tab Shift+Tab Up Down Enter Esc
       ├─ tab-jump:        Tab Shift+Tab Up Down Enter Esc
       ├─ export:          Tab Shift+Tab T/C/A/U Enter Esc
       ├─ preview:         h/l j/k g/G Home End Esc
       └─ shell:           Up Down PageUp PageDown Home End Esc
```

Shell overlay 打开时按 refs/mixcode 的焦点语义处理：`Ctrl+V`、`Ctrl+E` 不触发全局 preview/editor，而是作为控制字符写入 shell；`Ctrl+P` 仍保留为 command palette。`Esc` 单次关闭 shell。

`/models`、`/thinking`、`/context-limit`、`/theme`、`/workdir` 在无参数时会打开本地 picker overlay，支持输入过滤、上下移动、回车选择、Esc 取消。本地 `/theme` 参数支持 `mixcode-dark`、`claude-warm`、`tokyo-night`、`terminal`，也支持 `dark` 和唯一前缀如 `tok`；多匹配前缀如 `mix` 会显式报 ambiguous，不静默猜测。Pi extension `ctx.ui.setTheme("dark" | "mixcode-dark" | "claude-warm" | "tokyo-night" | "terminal")` 走同一套归一化并请求 redraw。Agent 输入 meta 行里的 workdir、model、thinking 三段也可用鼠标点击，分别复用 `/workdir`、`/models`、`/thinking` picker。编辑器补全覆盖 `/` slash commands、`$skill` 和 `@path`；`@path` 候选同时包含文件与带尾斜杠的目录，目录 query 如 `@src/` 会列出直接子项，带空格路径会插入为 `@"dir with spaces/"`。

全局 `@` 文件 picker 参考 `refs/mixcode/mixcode/widgets/file_picker.py` 的真实实现，而不是 README 推测：

```text
@ key
  │
  ├─ insert literal "@"
  └─ open @ File Picker
       │
       ├─ fuzzy mode
       │    ├─ printable chars update query
       │    ├─ up/down select
       │    └─ Tab -> tree mode
       │
       ├─ tree mode
       │    ├─ direct children for directory queries
       │    ├─ j/k select
       │    ├─ gg/G top/end
       │    └─ Tab -> fuzzy mode
       │
       ├─ Ctrl+G toggles ignored-path visibility
       ├─ Enter inserts @path or @"path with spaces"
       └─ Esc / empty backspace cancels
```

Command palette 不是全量 slash command 列表，而是复刻原项目的当前 tab 语境入口；其中与原项目专有 attach 终端绑定的入口不迁移到 pi 版本：

```text
Ctrl+P
  │
  ├─ Config tab
  │    ├─ /theme /tui-state /new-session
  │    ├─ /save-workspace /restore-workspace /delete-workspace
  │    └─ /delete-all-sessions
  │
  └─ Agent tab
       ├─ /models /thinking /context-limit /theme /tui-state /goal
       ├─ /rename /workdir /shell
       ├─ /toggle-todo /mark-done
       └─ /new-session /close-session /delete-session /delete-all-sessions
```

不可用命令不会出现在 palette 列表中；回车在空列表上直接关闭 palette，不执行任何操作。

为避免抢占其它交互，以下场景下 `Ctrl+P` 不打开 command palette：

```text
completion/picker/tab-jump overlay 打开
preview overlay 打开
当前 tab 没有可用 palette command
```

shell 按当前 MixCode 交互要求单 `Esc` 关闭：

```text
Shell overlay
  Esc ──> ShellManager.close(tab)
          shellOpen = false
```

Shell overlay 的本地 scrollback 映射：

```text
shell buffer
  │
  ├─ renderShellOverlay()
  │    └─ shellScrollOffset + visible window
  │
  ├─ mouse wheel up/down
  │    ├─ plain shell: scrollShell(-3 / +3)
  │    ├─ alternate-screen: forward ↑/↓ to shell stdin
  │    └─ SGR mouse enabled: forward wheel/down/up as \x1b[<button;x;yM/m
  │
  └─ arrow/home/end while shell panel is active
       └─ scrollShell(), without stealing printable shell input
```

## Slash Command 映射

```text
legacy local/runtime commands
        │
        v
src/core/commands.ts
        │
    ├─ UI state command
    │   /toggle-todo /theme /context-limit /tui-state /goal
        │
    ├─ session command
    │   /new-session /fork /clear /close-session /delete-session
    │   /delete-all-sessions /compact /import
        │
        ├─ workspace command
        │   /save-workspace /restore-workspace /delete-workspace
        │
        └─ prompt-template command
            /goal /compact
```

`/context-limit <tokens|reset>` 会设置当前 tab 的上下文窗口限制；自定义限制会同步调整 SDK compaction 的 `reserveTokens` 与 `keepRecentTokens`，`reset` 会恢复 SDK 默认 compaction token 配置。

`/import <jsonl-path> [cwdOverride]` 复用 Pi session JSONL 导入语义：

```text
/import path.jsonl
  │
  ├─ 校验文件存在、header 有 session/cwd
  ├─ cwd 不存在时显式报错，用户可提供 cwdOverride
  ├─ 复制 JSONL 到当前 session dir
  ├─ 触发 session_before_switch(reason=resume)
  └─ SessionManager.open(...) 后替换当前 AgentSession
```

## Goal 状态映射

原项目的 `/goal` 是 TUI 拥有的长期目标状态，而不是普通远端运行时命令。当前实现把它映射到 `MixCodeTabInfo.goal`：

```text
/goal ship feature
  │
  ├─ parseGoalCommandArgs() -> set
  ├─ applyGoalAction()      -> tab.goal = active
  └─ runtime.prompt()       -> Start working toward this MixCode goal

assistant reply
  │
  └─ MIXCODE_GOAL_COMPLETE 独立行
       └─ consumeGoalCompletionMarker() -> tab.goal.status = complete
```

支持的本地动作：

```text
/goal                 查看当前 goal
/goal <text>          设置 active goal 并发送启动 prompt
/goal set <text>      同上
/goal pause           暂停本地 goal
/goal resume [text]   恢复 goal 并发送 resume prompt
/goal complete        本地标记完成
/goal clear           清除本地 goal
```

## 测试和验收

```text
npm run check
  │
  ├─ typecheck      tsc --noEmit
  ├─ build          tsup ESM + d.ts
  └─ coverage       c8 lines/branches/functions/statements >= 95%
```

当前测试覆盖重点：

```text
core state        commands / tabs / overlays / command palette / workspace
agent runtime     session repo / stream events / tools / compaction
ui rendering      header / tabs / status / command palette
ui input          global keys / tab jump
bootstrap         initial state / persisted restore / completion sources
```

验收时不能只看覆盖率。还需要逐项对照：

```text
显式要求
  ├─ TypeScript 源码和构建产物
  ├─ pi-tui / pi-agent-core / pi-ai 依赖和实际 import
  ├─ 无 legacy server 运行依赖
  ├─ refs/mixcode 仅作为参考
  ├─ 主要功能、快捷键、UI、鼠标行为复刻程度
  ├─ legacy session/tool/provider 能力到 Pi 模型的映射
  ├─ 覆盖率 >= 95%
  └─ docs 中文技术方案与 ASCII 图
```

## 真实源码对照

```text
refs/mixcode 行为                         mixcode-pi 当前状态
──────────────────────────────────────    ─────────────────────────────
Textual widget click / hover / scroll      已覆盖 preview 滚轮、tab bar 点击切换、input meta 点击 picker、@ file picker 键盘流；pi-tui 事件层没有 Textual hover API
r 应用级 refresh 绑定                      保留为按键刷新状态；不暴露 slash command，避免和用户命令面混在一起
模型/思考/workdir modal picker             已有 pi-tui overlay picker，非 Textual modal
@ file picker fuzzy/tree/Ctrl+G            已覆盖 fuzzy、tree、ignored toggle、j/k/gg/G、Enter 插入、Esc/empty-backspace 取消
复杂 shell terminal 鼠标转发与 scrollback  已覆盖本地 scrollback、滚轮、alternate-screen wheel、SGR wheel/down/up、单 Esc 关闭；高层 hover 语义受 pi-tui 事件模型限制
quit confirm overlay                      单独使用 top-center 小框，避开 pi-tui overlay 无法覆盖 terminal image 行的问题；见 tmp/tui-verify-200743/02-quit.png
```

处理原则：

```text
不做静默假复刻
  │
  ├─ 有 pi-tui 能力时：实现行为并补测试
  ├─ 会破坏 prompt 输入时：保留输入正确性并记录差异
  └─ pi-tui 缺少事件层时：先暴露缺口，不写不可验证的模拟成功路径
```

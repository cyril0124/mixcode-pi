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
│   ├── open-tabs-store.ts    open_tabs.json 读写与跨实例 tab 集合变更
│   ├── peer-tab-sync.ts      跨实例 tab 监听与对账（open/close 协调）
│   ├── state-store.ts        TUI 状态与 workspace 持久化
│   └── system-prompt.ts        通过 Pi resource loader 构建 system prompt
├── agent/
│   ├── runtime.ts            MixCodeRuntime -> pi Agent/Session
│   ├── tools.ts              Pi built-in tools、extension tool owner 合并与 Tool Owners 摘要
│   └── faux-stream.ts        测试和本地演示用 faux model stream
└── ui/
    ├── app.ts                pi-tui Root、Editor、全局键处理
    ├── agent-tab-actions.ts  openExistingAgentTab / closeExistingAgentTab 等 tab 生命周期操作
    ├── rendering.ts          类 MixCode 的 header/tab/status/panel/floating panel 渲染
    └── completion.ts         /、@ 两类补全（$skill 补全由 mpi-skill-refs 扩展提供）
```

## 运行时映射

```text
用户输入
  │
  ├─ 普通 prompt
  │    └─ 原样透传给 Pi AgentSession.prompt()
  │        ├─ $skill 引用（由 mpi-skill-refs 扩展在 Pi 原生管线中展开）
  │        ├─ /skill: 与 prompt 模板（由 Pi 原生 _expandSkillCommand / expandPromptTemplate 展开）
  │        ├─ @file 引用
  │        └─ 不注入 AGENTS.md；项目上下文进入 system prompt
  │
  ├─ /local-command
  │    ├─ 纯 UI 状态：/toggle-todo /preview /mark-done
  │    ├─ 会话操作：/new-session /fork /compact /delete-session
  │    └─ prompt 模板：/goal /compact
  │
  └─ !shell / !!shell
       └─ 走 Pi AgentSession.executeBash（!! = excludeFromContext）
            ├─ 写入 session bashExecution
            ├─ UI 渲染为 user-bash 块
            └─ streaming 期间先挂 pending 区，agent_end 后并入主 chat

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
├────────────────────────────────────────────────────────────┤
│ Chat (user / assistant / tool / bash)                      │
│ optional: extension side panel on the right                │
├────────────────────────────────────────────────────────────┤
│ Shell / Markdown Preview overlays                           │
├────────────────────────────────────────────────────────────┤
│ > prompt editor                                             │
├────────────────────────────────────────────────────────────┤
│ status meta: model / thinking / workdir / git (hidden if extension footer set) │
└────────────────────────────────────────────────────────────┘
```

Config tab 只渲染配置面板和可点击操作，不渲染 prompt editor；这是为了避免在配置页出现无效的 Input Message 输入框。输入区下方不保留 refs/mixcode 的完整快捷键 footer；对话顶部 header 显示紧凑快捷键提示，`Ctrl+O` 可展开为完整全局键表，分作用域的完整列表仍在 help overlay（`/hotkeys`）中。

| 快捷键 | 当前行为 |
| --- | --- |
| `Tab` | 下一个 tab，补全打开时交给 Editor 接受候选；**Zen 模式**下吞掉（不切换 tab，也不走 vim tab-cycle） |
| `Shift+Tab` | 上一个 tab，补全打开时不抢占；**Zen 模式**下同样吞掉 |
| `r` | config tab 或 overlay 场景从 pi runtime 刷新 tab 状态；agent 输入中保留普通字符 |
| `Ctrl+P` | 可过滤命令面板；按 Config/Agent tab 显示当前语境命令，回车执行可用命令 |
| `Ctrl+T` | tab jump 模糊跳转；打开后 `Tab`/`Shift+Tab` 在候选中移动，`Ctrl+F` 切换仅显示非 idle（busy/done/waitingForInput/error）tab，不穿透到全局 tab 切换 |
| `Ctrl+E` | 外部编辑器编辑输入 |
| `Ctrl+C` | 清空普通编辑输入 |
| `Ctrl+J` / `Shift+Enter` | 在当前 Editor 光标处插入换行 |
| `Ctrl+O` | 展开/收起 tool 输出块与 header 快捷键提示（共用 tools-expand 状态） |
| `Ctrl+R` | 预填 `/rename 当前标题`，复用 slash command 重命名 |
| `Esc Esc` | 编辑器为空时打开 session tree（既有 double-Esc 路径） |
| `Alt+Up` / `Ctrl+U` | 将队列里最后一条消息弹回编辑器（**优先 follow-up，再 steer**）；**两队列都空时 Ctrl+U 武装 1s 内 `u`/`Ctrl+U` 进入 Vim**（toast 提示 `Again: u or Ctrl+U → vim`；Home / Alt+Up 不武装；始终消费以免落到 Editor 行首删除） |
| `Up` / `Down` | 普通输入为空且无 overlay、preview、补全、extension terminal input 消费时浏览当前 tab 的 prompt 历史；其它场景交给局部控件 |
| `Right` | Vim 模式跳到更新的 user message，并短暂显示右锚定 `User Messages` 预览；非 Vim 普通输入为空且无 overlay、preview、补全、extension user interaction 时切换 extension widget side panel；无 widget 或终端过窄时显示 toast；有输入时交给 Editor 光标移动 |
| `Shift+Right` | Vim 模式跳到更旧的 user message，并短暂显示右锚定 `User Messages` 预览 |
| `@` | 打开 mixcode 风格全局文件 picker，选择后插入 `@path ` |
| `Esc` | 关闭 overlay、preview 或 tab jump；standalone `!shell` 一次中止；bash-mode 草稿 `!...` 清空 |
| `Ctrl+Q` | 打开退出确认；`y` 确认、`n`/`Esc` 取消；`/quit` 和 `/exit` 直接退出，不弹确认 |
| `q` | 普通输入字符，不绑定退出，避免破坏 prompt 输入 |

Session tree 默认无全局和弦（可用 `/tree`、空输入 Double-Esc，或在 `keybindings.json` 自绑 `app.session.tree`）；`/resume`、`/fork`、`/new-session` 走 slash / palette。

Vim user-message 导航预览是一个自动过期的 floating panel，覆盖在 editor 上方，列出附近 user prompts 和 `<NEWEST>`；Vim 状态提示为 `Vim: → newer user msg · Shift+→ older user msg`。

`/toggle-zen-mode` 切换当前 agent 的 Zen 模式（tab 级、不写全局 settings）：隐藏 tab bar；Tab/Shift+Tab 被吞掉，换 tab 只靠 Ctrl+T（或 Home attach）；editor 顶栏显示 `[ZEN]`；分隔线左侧用彩色实心圆 `●` 显示其他 agent 的有效状态：强调色表示 running/thinking，黄色表示等待输入，绿色表示 done/unreadDone，红色表示 error。活动 agent、idle 和 Not Ready 不显示；状态优先级与 tab bar 一致（error > 等待输入 > working > done），最多显示 5 个标记，超出显示 `[+N]`。与 Vim 可并存；agent→agent 切换时 vim/zen 随目标转移，回 Home 时标志留在 agent 上。

`src/core/keymap.ts` 是带作用域的可审计 keymap，不只记录全局键。`global` 作用域覆盖主输入表面，`file-picker`、`picker`、`command-palette`、`tab-jump`、`export`、`preview` 作用域覆盖 overlay 或局部交互；`describeKeymap()` 保持旧的简短输出，`describeScopedKeymap()` 用于审计完整局部键表。

```text
key input
  │
  ├─ global
  │    ├─ Tab / Shift+Tab / Ctrl+P / Ctrl+T
  │    ├─ Ctrl+E / Ctrl+V / Ctrl+C / Ctrl+R / Ctrl+O / Ctrl+Q
  │    └─ @ / Esc / Esc Esc / Alt+Up / Ctrl+U / Up / Down / Right / Shift+Right
  │
  └─ scoped overlays
       ├─ picker:          Tab Shift+Tab Up Down Enter Esc
       ├─ file-picker:     Tab Ctrl+G j/k g/G Enter Esc
       ├─ command-palette: Tab Shift+Tab Up Down Enter Esc
       ├─ tab-jump:        Tab Shift+Tab Up Down Enter Esc
       ├─ export:          Tab Shift+Tab T/C/A/U Enter Esc
       └─ preview:         h/l j/k g/G Home End Esc
```

`!` / `!!` 不是独立 shell overlay：输入以 `!` 开头时 editor 进入 bash-mode 边框，提交后走 Pi `executeBash`。standalone bash 运行中 Esc 一次中止；agent streaming 时 Esc 仍走 agent abort 二次确认。

`/thinking` 与 `/hide-thinking` 是两件不同的事：`/thinking` 调整当前 tab 模型的 reasoning level（`off`/`low`/`medium`/`high`/`max`），影响模型实际推理量；`/hide-thinking` 只切换 thinking 内容在 TUI 的可见性，隐藏时折叠为斜体 `Thinking...` 占位，不改变推理 level、不改写会话内容。`/hide-thinking` 是全 tab 生效的应用级 toggle，复用 Pi 原生 `hideThinkingBlock` 设置持久化（启动时 `SettingsManager.getHideThinkingBlock()` 读取，切换时 `setHideThinkingBlock()` 写回全局 `settings.json`），跨重启保持，并沿用 Pi 的状态文案 `Thinking blocks: hidden|visible`。因为它写入 Pi 全局 `settings.json`（跨重启、跨 workdir、与 Pi agent 共享），其 `description` 以 `[global]` 前缀标注，让用户在 palette / slash 补全里执行前即可看出这是全局持久化设置；约定见 AGENTS.md 的 Slash Commands。

`/models`、`/thinking`、`/context-limit`、`/workdir` 在无参数时会打开本地 picker overlay，支持输入过滤、上下移动、回车选择、Esc 取消。`/thinking` 的候选来自当前 tab 模型能力；不支持 reasoning 的模型只显示 `off`，带 `thinkingLevelMap` 的模型可显示 Pi 支持的新 level（如 `max`）。UI 主题改由 `/settings` 面板编辑（写入 `mixcode_settings.json` 的 `theme`，未设置时保留 runtime/default）；Pi extension `ctx.ui.setTheme("dark" | "mixcode-dark" | "claude-warm" | "tokyo-night" | "terminal")` 仍走同一套归一化并请求 redraw。Agent 输入 meta 行里的 workdir、model、thinking 三段也可用鼠标点击，分别复用 `/workdir`、`/models`、`/thinking` picker；当 tab 设置了 extension footer 时 meta 整行折叠（footer 已承载 cwd/model/context/git/status，避免双层重复），点击 picker 亦随之不可用。编辑器补全覆盖 `/` slash commands、`$skill` 和 `@path`；`@path` 候选同时包含文件与带尾斜杠的目录，目录 query 如 `@src/` 会列出直接子项，带空格路径会插入为 `@"dir with spaces/"`。

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
  │    ├─ /settings /tui-state /new-session /hide-thinking
  │    ├─ /save-workspace /restore-workspace /delete-workspace
  │    ├─ /close-all-sessions /delete-all-sessions
  │    └─ /login /logout
  │
  └─ Agent tab
       ├─ /models /thinking /context-limit /settings /tui-state
       ├─ /system-tools /system-prompt /toggle-hidden-messages /hide-thinking /extension-manager /reload /session /export
       ├─ /rename /workdir /import /mark-done /vim /toggle-zen-mode
       ├─ /fork /compact /clear /reset /navigate /tree
       ├─ /help /hotkeys /quit /exit
       ├─ /new-session /resume /close-session /delete-session
       ├─ /follow-up
       ├─ /close-all-sessions /delete-all-sessions
       └─ /login /logout
```

不可用命令不会出现在 palette 列表中；回车在空列表上直接关闭 palette，不执行任何操作。

为避免抢占其它交互，以下场景下 `Ctrl+P` 不打开 command palette：

```text
completion/picker/tab-jump overlay 打开
preview overlay 打开
当前 tab 没有可用 palette command
```

`!` / `!!` shell（Pi bash 对齐）：

```text
Editor !cmd / !!cmd
  │
  ├─ parseInput → kind:shell
  ├─ AgentSession.executeBash / emitUserBash
  ├─ chat: user-bash 块
  │    Running... (Esc to cancel) | agent busy → Running... (agent Esc aborts run)
  ├─ session: bashExecution（!! excludeFromContext）
  └─ Esc:
       ├─ isBashRunning && !streaming → abortBash
       └─ bash-mode draft (!...) → clear editor
```

## Slash Command 映射

```text
legacy local/runtime commands
        │
        v
src/core/commands.ts
        │
    ├─ UI state command
    │   /toggle-todo /settings /context-limit /tui-state /goal
        │
    ├─ session command
    │   /new-session /fork /clear /reset /close-session /delete-session
    │   /close-all-sessions /delete-all-sessions /compact /import
        │
        ├─ workspace command
        │   /save-workspace /restore-workspace /delete-workspace
        │
        ├─ auth command
        │   /login /logout
        │
        └─ prompt-template command
            /goal /compact
```

`/context-limit <tokens|reset>` 会设置当前 tab 的上下文窗口限制；自定义限制会同步调整 SDK compaction 的 `reserveTokens` 与 `keepRecentTokens`，`reset` 会恢复该 tab 启动时捕获的用户基线 compaction 配置；若未捕获基线则报错（不再回落到 SDK 默认）。每个 tab 拥有独立的 `SettingsManager`，因此 `/context-limit` 覆盖不会在独立 tab 之间泄漏；同源 fork/reuse 的 tab 仍共享同一 manager。

`/context-limit` 还会把当前 tab 的有效窗口写入该 session 的 live `model.contextWindow`，让 Pi 原生 compaction 与读取 `ctx.model` / `getContextUsage().contextWindow` 的 extension 看到同一值；这是 session 内临时覆盖，不回写 `models.json`。`tab.model.contextWindow` 仍保留模型 canonical capacity，供 reset / picker 使用。创建 session 与切模型时会对 model 做浅拷贝，避免一个 tab 的 limit 改到另一个共享同一 model 对象的 session。

### Compaction 边界

```text
core (mixcode runtime)
  ├─ overflow        → Pi AgentSession compact + willRetry continue
  ├─ turn 边界 threshold → Pi agent_end / 下次 prompt 前 _checkCompaction
  └─ /compact        → agentSession.compact()

pi-packages/mpi-mid-turn-compact (built-in extension)
  └─ complete tool batch on `context` + usage over window-reserve
       → abort → native compact (Pi summarization retry) → short followUp resume
```

Core **不再**在 `afterToolCall` 上做 mid-turn terminate + 私有 `_handlePostAgentRun` 续跑。
长 tool loop 的 mid-turn 路径由内置扩展 `mpi-mid-turn-compact` 承担（`MPI_MID_TURN_COMPACT=0` 可关）。

`/import <jsonl-path> [cwdOverride]` 复用 Pi session JSONL 导入语义：

```text
/import path.jsonl
  │
  ├─ 校验文件存在、header 有 session/cwd
  ├─ cwd 不存在时显式报错，用户可提供 cwdOverride
  ├─ 外部 JSONL 先在私有临时文件上完成 Pi 迁移，再原子、无覆盖地发布到当前 session dir
  │    └─ 同名目标已存在时显式失败，保留原文件
  ├─ 触发 session_before_switch(reason=resume)
  └─ SessionManager.open(...) 后替换当前 AgentSession
```

## Goal 状态映射

`/goal` 由内置扩展 `pi-packages/mpi-goal` 提供（`ensurePackageExtensions` /
`binary-entry` 嵌入）。目标状态保存在当前 session 分支的 custom entry
（`mpi-goal-*` 前缀），不是 `MixCodeTabInfo` 字段。

```text
/goal ship feature
  │
  ├─ mpi-goal /goal command
  ├─ session appendEntry(mpi-goal-*)
  ├─ progressive tools activated (create/queue/pause/...)
  └─ lifecycle continues work toward the objective

/goal                 open management overlay
/goal tools           activate goal model tools
/goal pause|resume|clear
/goal queue ...
```

能力边界与安装约定见 `pi-packages/mpi-goal/README.md`。

## 测试和验收

```text
bun run check
  │
  ├─ typecheck      tsc --noEmit
  ├─ build          tsup ESM + d.ts
  └─ test           node --test
```

当前测试重点：

```text
core state        commands / tabs / open-tabs-store / peer-tab-sync / overlays / command palette / workspace
agent runtime     session repo / stream events / tools / compaction
ui rendering      header / tabs / status / command palette
ui input          global keys / tab jump
bootstrap         initial state / persisted restore / completion sources
```

验收时需要逐项对照：

```text
显式要求
  ├─ TypeScript 源码和构建产物
  ├─ pi-tui / pi-agent-core / pi-ai 依赖和实际 import
  ├─ 无 legacy server 运行依赖
  ├─ refs/mixcode 仅作为参考
  ├─ 主要功能、快捷键、UI、鼠标行为复刻程度
  ├─ legacy session/tool/provider 能力到 Pi 模型的映射
  ├─ 自动化测试可运行
  └─ docs 中文技术方案与 ASCII 图
```

## 真实源码对照

```text
refs/mixcode 行为                         mixcode-pi 当前状态
──────────────────────────────────────    ─────────────────────────────
Textual widget click / hover / scroll      已覆盖 preview 滚轮、tab bar 点击切换/再点当前 tab 打开 Tab Jump、Command Palette / Tab Jump 滚轮与点击、input meta 点击 picker、@ file picker 键盘流；pi-tui 事件层没有 Textual hover API
r 应用级 refresh 绑定                      保留为按键刷新状态；不暴露 slash command，避免和用户命令面混在一起
模型/思考/workdir modal picker             已有 pi-tui overlay picker，非 Textual modal
@ file picker fuzzy/tree/Ctrl+G            已覆盖 fuzzy、tree、ignored toggle、j/k/gg/G、Enter 插入、Esc/empty-backspace 取消
复杂 shell terminal 鼠标转发与 scrollback  已覆盖本地 scrollback、滚轮、alternate-screen wheel、SGR wheel/down/up、单 Esc 关闭；高层 hover 语义受 pi-tui 事件模型限制
quit confirm overlay                      使用 center 小框（Ctrl+Q / close-session 等共用 quitOverlayOptions）；见 tmp/tui-verify-200743/02-quit.png
```

处理原则：

```text
不做静默假复刻
  │
  ├─ 有 pi-tui 能力时：实现行为并补测试
  ├─ 会破坏 prompt 输入时：保留输入正确性并记录差异
  └─ pi-tui 缺少事件层时：先暴露缺口，不写不可验证的模拟成功路径
```

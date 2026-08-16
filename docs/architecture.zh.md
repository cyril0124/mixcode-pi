# MixCode Pi 架构

[English Documentation](architecture.md)

MixCode 是基于 Pi（`pi-tui` / `pi-agent-core` / `pi-ai`）的多 tab TUI agent。本文记录当前实现的分层、运行时、快捷键和命令。

## 总体结构

```text
┌────────────────────────┐
│ @earendil-works/pi-tui │
│ Root + Editor + Overlay │
└────────────┬───────────┘
             │
             v
┌────────────────────────┐
│ pi-agent-core Agent     │
│ SessionManager          │
│ AgentEvent stream       │
└────────────┬───────────┘
             │
             v
┌────────────────────────┐
│ @earendil-works/pi-ai   │
│ Model + stream + tools   │
└────────────────────────┘
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
    ├── rendering.ts          header/tab/status/panel/floating panel 渲染
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

快捷键与 Escape 分发的权威说明见 [快捷键与 Escape](keybindings-and-escape.zh.md)。
`Tab` / `Shift+Tab` 仅在补全关闭且非 Zen 时轮转 Tab。

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
│ Prompt Editor (with / $ @ completion)                      │
└────────────────────────────────────────────────────────────┘
```

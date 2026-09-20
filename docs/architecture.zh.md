# MixCode Pi 架构

[English Documentation](architecture.md)

MixCode 是基于 Pi（`pi-tui` / `pi-agent-core` / `pi-ai`）的多 tab TUI agent。本文记录当前实现的分层、运行时、快捷键和命令。

## 总体结构

```text
┌─────────────────────────┐
│ @earendil-works/pi-tui  │
│ Root + Editor + Overlay │
└────────────┬────────────┘
             │
             v
┌─────────────────────────┐
│ pi-agent-core Agent     │
│ SessionManager          │
│ AgentEvent stream       │
└────────────┬────────────┘
             │
             v
┌─────────────────────────┐
│ @earendil-works/pi-ai   │
│ Model + stream + tools  │
└─────────────────────────┘
```

## 模块分层

```text
src/
├── cli/
│   └── bootstrap.ts          启动状态、workspace、completion source
├── core/
│   ├── commands.ts           本地 slash command 解析与补全源
│   ├── tabs.ts               tab 增删改与前后环绕切换
│   ├── overlays.ts           tab jump、command palette、overlay 路由等纯状态逻辑
│   ├── open-tabs-store.ts    open_tabs.json 读写与跨实例 tab 集合变更
│   ├── batch-lua.ts          --batch 计划收集（.lua 走 fengari）与共用校验/应用
│   ├── batch-ts.ts           --batch 计划收集（.ts/.mts/.js/.mjs 脚本模块）
│   ├── peer-tab-sync.ts      跨实例 tab 监听与对账（open/close 协调）
│   ├── state-store.ts        TUI 状态与 workspace 持久化
│   └── system-prompt.ts        通过 Pi resource loader 构建 system prompt
├── agent/
│   ├── runtime.ts            MixCodeRuntime -> pi Agent/Session
│   ├── tools.ts              Pi built-in tools、extension tool owner 合并与 Tool Owners 摘要
│   └── faux-stream.ts        基于 pi-ai faux provider core 的回显 faux 模型（测试、本地演示）
└── ui/
    ├── app.ts                pi-tui Root、Editor、全局键处理
    ├── agent-tab-actions.ts  openExistingAgentTab / closeExistingAgentTab 等 tab 生命周期操作
    ├── rendering.ts          header/tab/status/panel/floating panel 渲染
    └── components/           自包含 widget/overlay（选择器、设置面板、扩展管理器等）
        └── completion.ts     /、@ 两类补全（$skill 补全由 mpi-skill-refs 扩展提供）
```

## 运行时映射

`src/core/commands.ts` 识别 `LOCAL_COMMANDS` 中注册的本地命令，
本地命令优先于同名扩展命令和 prompt 模板。Pi 的 `AgentSession.prompt()`
依次处理其余 slash 输入：扩展命令、`input` 事件、skill/模板展开、用户消息。
扩展命令和 input handler 可以直接处理完输入，无需启动模型回合。

未匹配的 slash 输入，例如 `/home/example/session.jsonl` 或 `/unknown`，
会作为消息文本发送，处理方式不取决于文件是否存在。分发器去除 slash 输入开头的空白。
交给 Pi 的 slash 输入保留内部空白和换行。本地 handler 同时接收合并空白后的
`args` 和保留原始空白的 `rawArgs`；`/batch` 解析 `rawArgs`，保留引号内的空白。
`AGENTS.md` 等项目上下文在 system prompt 中组装。

```text
User Input
  │
  ├─ Registered /local-command
  │    └─ MixCode handler (UI, settings, or session operation)
  │
  ├─ Other input, including unknown slash input and paths
  │    └─ Pi AgentSession.prompt()
  │        ├─ Registered extension command -> execute
  │        └─ input event -> skill/template expansion -> user message
  │             └─ $skill references are handled by mpi-skill-refs
  │
  └─ !shell / !!shell
       └─ 走 Pi AgentSession.executeBash（!! = excludeFromContext）
            ├─ 写入 session bashExecution
            ├─ UI 渲染为 user-bash 块
            └─ streaming 期间先挂 pending 区，agent_end 后并入主 chat

MixCodeRuntime
  │
  ├─ SessionManager        保存/恢复/克隆分支/清空替换/删除 session
  ├─ prompt history        getPromptHistory() 读取当前 SDK branch 的 user prompt；workspace restore 后回填 tab.promptHistory
  ├─ Agent                 执行 prompt 和工具
  ├─ AgentEvent            映射为 tab status、chat、todos、questions、goal
  └─ pi-ai Model           provider/modelId 解析，faux provider 经 pi-ai createFauxCore 流式输出
```

## 后台会话目录

`src/core/session-catalog.ts` 为启动和后台会话查找预热、缓存完整的 Pi `SessionInfo[]`。源码运行使用 worker 线程；编译版 `mpi` 通过内部参数 `--mixcode-session-catalog-worker` 启动自身子进程，其 JSONL 传输由 `src/core/session-catalog-stream.ts` 管理。

子进程为每个会话输出一条 `{"type":"session","session":...}`，保留包括 `allMessagesText` 在内的全部字段，最后输出 `{"type":"done","count":N}`。每次写入完成后才发送下一条，将待写缓冲限制为一帧。父进程按行收集字节片段，每行仅合并一次，校验帧并恢复日期，解析累计约 10 毫秒后在帧之间让出事件循环。单个会话仍同步解析，数据不会被截断。

仅在结束帧计数匹配、到达 EOF 且退出码为 0 时返回并缓存目录。非法或截断输出以 `Error: Invalid session catalog stream: ...` 报错，子进程失败诊断向调用方传递。取消以 `AbortError` 拒绝，关闭读取并终止子进程；若 SIGTERM 后一秒仍未退出，则发送 SIGKILL。失败和取消均不发布部分结果。stderr 并行读取，子进程回收后才结束请求。

不带取消信号的请求共享进行中的工作；成功结果沿用按根目录失效和最新在前的排序规则。交互式 `/resume` 选择器的进度加载器直接调用 Pi，不使用这条传输路径。

## UI 和快捷键

快捷键与 Escape 分发的权威说明见 [快捷键与 Escape](keybindings-and-escape.zh.md)。
`Tab` / `Shift+Tab` 仅在补全关闭且非 Zen 时轮转 Tab。

```text
┌────────────────────────────────────────────────────────────┐
│ Header: MixCode                                            │
├────────────────────────────────────────────────────────────┤
│ [Home] [Agent-01] [Agent-02*]          Ctrl+T:Jump         │
├────────────────────────────────────────────────────────────┤
│ Status: Context / State / Model                            │
├────────────────────────────────────────────────────────────┤
│ Chat (user / assistant / tool / bash)                      │
│ optional: extension side panel on the right                │
├────────────────────────────────────────────────────────────┤
│ Shell overlay                                              │
├────────────────────────────────────────────────────────────┤
│ Prompt Editor (with / $ @ completion)                      │
└────────────────────────────────────────────────────────────┘
```

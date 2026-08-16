# 内置扩展 (`mpi-*`)

[English Documentation](builtin-extensions.md)

MixCode 随附位于 `pi-packages/mpi-*` 的第一方内置 Pi 包。启动时，每个包都会释放到 `<agentDir>/extensions/`；package extension 通过 Pi 公开的 `resources_discover` 事件提供运行时发现的 skill，不会复制到 `<agentDir>/skills`。

## 功能目录

| 扩展包 | 命令 / 触发方式 | 说明 |
|---|---|---|
| `mpi-goal` | `/goal [objective]`, `/goal tools`, `/goal pause\|resume\|clear` | 目标追踪系统，支持会话级隔离、渐进式模型工具暴露、连续执行预算控制与底部状态挂件。 |
| `mpi-loop` | `/loop [interval] <prompt>`, `/loop stop <id\|name>`, `/loop interval <id> <time>` | 定时循环任务引擎，支持定时器冲突处理（`skip` 跳过 / `defer` 延后排队）、编辑器下方常驻状态挂件及全屏管理浮层。 |
| `mpi-optimize-prompt` | `/optimize-prompt [prompt]`, `/optimize-prompt-config` | 基于 Meta-prompt 的提示词优化器，将模糊指令细化为高清晰度、结构化可执行的 Prompt。 |
| `mpi-auto-rename` | 第 1 轮自动触发, `/auto-rename [name]` | 首轮对话后调用轻量级模型生成简明 Tab 标题。 |
| `mpi-skill-refs` | `$` 补全触发符 | 项目和全局 Skill 自动补全及 Prompt 内联展开。 |
| `mpi-prompt-history` | `/prompt-history` | 交互式 Prompt 历史记录搜索、过滤及直接插入编辑器。 |
| `mpi-chat-view` | `/view [chat\|thinking\|last\|user]` | 在外部编辑器（`$VISUAL` / `$EDITOR`）或内置查看器中检视完整对话、Thinking 推理或最近消息。 |
| `mpi-diff-viewer` | `/diff [ref]` | 终端内交互式 Diff 查看器，支持 hunk 导航与行级评审注释。 |
| `mpi-command-browser` | Slash `/` 自动补全 | 模糊检索与浏览所有已注册的 Slash 命令与第三方扩展指令。 |
| `mpi-model-skills` | `/model-skills`，`<agentDir>/model-skills.json` | 按当前模型匹配规则动态挂载或卸载 Skill。 |
| `mpi-model-extensions` | `/model-extensions`，`<agentDir>/model-extensions.json` | 按当前模型动态加载 Pi 扩展。 |
| `mpi-mid-turn-compact` | Token 达到阈值时自动触发 | 轮次中上下文自动压缩策略，防止多工具连续调用耗尽上下文窗口。 |
| `mpi-search-guard` | 触发大范围目录遍历时拦截 | 拦截对根目录、`~` 等高基数目录的盲目递归搜索，引导 Agent 缩小搜索范围。 |
| `mpi-tool-block` | `/tool-block`，`<agentDir>/tool-block.json` | 弹出 overlay 勾选要隐藏的 tool，从 active 集合拿掉，模型看不见。 |
| `mpi-bash-default-timeout` | 执行 Bash 工具时自动生效 | 为 Bash 工具命令注入默认超时机制，防止任务无限期阻塞。 |
| `mpi-image-hoist` | 多模态输入时自动生效 | 提取并提升图片载荷，适配多模态模型与工具协议。 |
| `mpi-herdr-report` | `HERDR_ENV=1` 环境生效 | 将 Agent 的运行状态（working / idle / waiting）同步上报至 Herdr 终端复用器窗格。 |
| `mpi-ctl` | `$mpi-ctl`，`mpi status` / `mpi ctl` | Skill：用 `MIXCODE_*` 定位 tab，再用 `mpi status` / `mpi ctl` 控制正在跑的 TUI。 |

## 内置包加载生命周期

```text
MixCode 交互 / TUI 或独立 Pi subagent 启动
  │
  ├─ 释放二进制资产 -> runtimeDir/packages/（仅编译版 mpi）
  ├─ ensurePackageExtensions -> 拷贝 mpi-* 到 <agentDir>/extensions/
  ├─ Pi Resource Loader 发现 package extension
  └─ AgentSession.bindExtensions()
        ├─ session_start 触发扩展初始化
        ├─ resources_discover -> package skills/ 根目录
        └─ Pi Resource Loader 扩展已加载的 skill
```

## 仅加载内置扩展

若需排查第三方干扰或仅使用内置能力：

```bash
mpi --builtin-extensions-only
```

# 内置扩展 (`mpi-*`)

[English Documentation](builtin-extensions.md)

MixCode 随附位于 `pi-packages/mpi-*` 的第一方内置 Pi 包。启动时，每个包都会通过内容哈希同步到 `<agentDir>/extensions/`：哈希匹配时跳过目标写入，发生变化时替换已安装的包目录；package extension 通过 Pi 公开的 `resources_discover` 事件提供运行时发现的 skill，不会复制到 `<agentDir>/skills`。

每个带用户可编辑 JSON 配置的包都随扩展附带 JSON Schema（`<agentDir>/extensions/<pkg>/<config>.schema.json`，如 `mpi-permission.schema.json`、`mpi-tool-block.schema.json`）。在配置文件中用 `$schema` 键引用即可获得编辑器补全；加载器接受该键并在写回时保留。细节见各包 README。

## 功能目录

| 扩展包 | 命令 / 触发方式 | 说明 |
|---|---|---|
| `mpi-goal` | `/goal [objective]`, `/goal tools`, `/goal pause\|resume\|clear` | 目标追踪系统，支持会话级隔离、渐进式模型工具暴露、连续执行预算控制与底部状态栏组件。 |
| `mpi-loop` | `/loop [interval] <prompt>`, `/loop stop <id\|name>`, `/loop interval <id> <time>` | 定时循环任务引擎，支持配置总执行次数、定时器冲突处理（`skip` 跳过 / `defer` 延后排队）、编辑器下方常驻状态组件及全屏管理浮层。 |
| `mpi-optimize-prompt` | `/optimize-prompt [prompt]`, `/optimize-prompt-config` | 基于 Meta-prompt 的提示词优化器，将模糊指令细化为高清晰度、结构化可执行的 Prompt。 |
| `mpi-auto-rename` | 可选首条消息自动触发, `/auto-rename` | 生成短横线风格会话标题；在 `<agentDir>/mpi-auto-rename.json` 将 `onFirstMessage` 设为 `true` 以启用。 |
| `mpi-skill-refs` | `$` 补全触发符 | 项目和全局 Skill 自动补全及 Prompt 内联展开。 |
| `mpi-prompt-history` | `/prompt-history` | 交互式 Prompt 历史记录搜索、过滤及直接插入编辑器。 |
| `mpi-transcript` | `/transcript [context\|chatlog\|thinking\|latest-agent\|latest-user] [N] [full]` | 在 nvim、vim 或内置查看器中检视会话转录切片；使用 `/transcript config` 配置编辑器，只有对应命令的 `--version` 检查成功时才显示 nvim 和 vim。每个视图顶部都有圆角统计框，显示会话轮数、消息数、持续时间、工具结果状态、各工具调用次数和 `SKILL.md` 读取次数。`context` 视图顶部给出 chars/4 的体积估算——`系统提示 + 工具 schema + 全部消息`，模型上下文窗口已知时附带占比；该数字始终按完整上下文计算，`N` 只截断展示、不改变估算。nvim 额外提供 User/Assistant 标题 winbar、`]t`/`[t` 跳轮次与 `]u`/`[u` 跳用户消息、以覆盖式 `virt_text` 绘制并隐藏原始 markup 的角色徽章条与全宽分隔线、当前轮次左侧竖线、折叠工具 in/out 输出、淡化 meta/thinking、wrap/linebreak 与 `conceallevel=2`。vim 额外提供 User/Assistant 状态栏、`]t`/`[t` 跳轮次与 `]u`/`[u` 跳用户消息、隐藏 `##`/`###` 前缀的角色着色标题、将 `---` 隐藏为 `─`、折叠工具 in/out 输出、淡化 meta/thinking、wrap/linebreak 与 `conceallevel=2`。配色来自 `MpiTranscript*` 高亮组，以 `default = true` 链接，可被主题覆盖。成功 `read` 的 `SKILL.md` 渲染为技能卡片，含名称、路径、描述，以及剥离 frontmatter 后按 markdown 渲染的正文，正文 20 行截断（`full` 输出全文）。nvim 为技能标题提供单独的徽章条。 |
| `mpi-diff-viewer` | `/diff [ref]` | 终端内交互式 Diff 查看器，支持 hunk 导航与行级评审注释。 |
| `mpi-model-skills` | `/model-skills`，`<agentDir>/mpi-model-skills.json` | 按当前模型匹配规则动态挂载或卸载 Skill。 |
| `mpi-model-extensions` | `/model-extensions`，`<agentDir>/mpi-model-extensions.json` | 按当前模型动态加载 Pi 扩展。 |
| `mpi-length-resume` | 回答被长度截断时自动触发 | 回答因输出长度截断后自动续跑：原生自动压缩完成后、或 run 在接近上下文上限处以 length 结束时，通过隐藏 follow-up 恢复。轮内阈值压缩由 Pi 核心负责。 |
| `mpi-search-guard` | 触发大范围目录遍历时拦截 | 拦截对根目录、`~` 等高基数目录的盲目递归搜索，引导 Agent 缩小搜索范围。 |
| `mpi-tool-block` | `/tool-block`，`<agentDir>/mpi-tool-block.json` 或当前 session 内存 | 弹出 overlay 勾选要隐藏的 tool，从 active 集合拿掉，模型看不见。 |
| `mpi-permission` | `/permission`，`<agentDir>/mpi-permission.json`，`<cwd>/.pi/mpi-permission.json` | 用 allow / ask / deny 通配符规则把关工具调用，并扫描常见 Bash 文件命令的静态路径；含外部目录与重复调用（doom loop）防护；ask 审批支持 once / always / reject（doom_loop 的 ask 仅 once / reject）。详见 [pi-packages/mpi-permission/README.zh.md](../pi-packages/mpi-permission/README.zh.md)。 |
| `mpi-bash` | 执行 Bash 工具时自动生效、`/bash-logs` | 注入默认超时，前台窗口到期后自动转入后台，命令结束或长时间无输出时自动回报，并用两段 overlay 查看或终止后台命令。 |
| `mpi-tool-display` | 工具行/Thinking 渲染时自动生效；`/mpi-tool-display config` | 通过 render-only `ToolExecutionComponent` adapter 提供紧凑 `bash`/`read`/`edit`/`write` 行、bars/分栏 diff 与上下文安全的 Thinking 标签；全局调试设置可为每个工具调用追加原始 JSON 参数，同时不改变原生 ownership、执行逻辑或 `PI_*`。 |
| `mpi-image-hoist` | 多模态输入时自动生效 | 提取并提升图片载荷，适配多模态模型与工具协议。 |
| `mpi-herdr-report` | `HERDR_ENV=1` 环境生效 | 将 Agent 的运行状态（working / idle / waiting）同步上报至 Herdr 终端复用器窗格。 |
| `mpi-ctl` | `$mpi-ctl`，`mpi status` / `mpi ctl` | Agent Tab 协作 skill：用 `MIXCODE_*` 定位 tab，再用 `mpi status` / `mpi ctl` 向同伴发 Prompt / 等待 / 读结果。 |

## 内置包加载生命周期

```text
MixCode 交互 / TUI 或独立 Pi subagent 启动
  │
  ├─ 释放二进制资产 -> runtimeDir/packages/（仅编译版 mpi）
  ├─ installMixcodeDocs -> 写入 docs/*.md 到 <agentDir>/mixcode-docs/（仅编译版 mpi）
  ├─ ensurePackageExtensions -> 按哈希同步 mpi-* 到 <agentDir>/extensions/
  ├─ Pi Resource Loader 发现 package extension
  └─ AgentSession.bindExtensions()
        ├─ session_start 触发扩展初始化
        ├─ resources_discover -> package skills/ 根目录
        └─ Pi Resource Loader 扩展已加载的 skill
```

`ensurePackageExtensions` 会根据每个包的相对文件路径和文件内容计算确定性的 SHA-256。已安装包把哈希记录在 `<agentDir>/extensions/<package>/.mixcode-package-hash`；哈希匹配时跳过写入，发生变化时替换已安装的包目录，然后发布新的标记。包内 skill 保留在扩展目录中，由 `resources_discover` 加载。

`installMixcodeDocs` 仅在编译版二进制中执行，因为它磁盘上没有源码树。它把 MixCode 自身的
`docs/*.md` 写入 `<agentDir>/mixcode-docs/` —— 与 `<agentDir>/extensions/` 平级的稳定目录，
而非随进程生灭的 runtimeDir —— 供 system prompt 指引模型查阅。源码与 npm 装法跳过这一步，
直接解析仓库的 `docs/`。Pi 自身的文档从不拷贝到这里，而是由 Pi 的 `config.ts` 在 pi 包路径下解析。

## 仅加载内置扩展

若需排查第三方干扰或仅使用内置能力：

```bash
mpi --builtin-extensions-only
```

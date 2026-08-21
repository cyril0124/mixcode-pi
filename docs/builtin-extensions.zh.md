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
| `mpi-chat-view` | `/view [chat\|thinking\|last\|user]` | 在外部编辑器（`$VISUAL` / `$EDITOR`）或内置查看器中检视完整对话、Thinking 推理或最近消息。 |
| `mpi-diff-viewer` | `/diff [ref]` | 终端内交互式 Diff 查看器，支持 hunk 导航与行级评审注释。 |
| `mpi-command-browser` | Slash `/` 自动补全 | 模糊检索与浏览所有已注册的 Slash 命令与第三方扩展指令。 |
| `mpi-model-skills` | `/model-skills`，`<agentDir>/mpi-model-skills.json` | 按当前模型匹配规则动态挂载或卸载 Skill。 |
| `mpi-model-extensions` | `/model-extensions`，`<agentDir>/mpi-model-extensions.json` | 按当前模型动态加载 Pi 扩展。 |
| `mpi-mid-turn-compact` | Token 达到阈值时自动触发 | 轮次中上下文自动压缩策略，防止多工具连续调用耗尽上下文窗口。 |
| `mpi-search-guard` | 触发大范围目录遍历时拦截 | 拦截对根目录、`~` 等高基数目录的盲目递归搜索，引导 Agent 缩小搜索范围。 |
| `mpi-tool-block` | `/tool-block`，`<agentDir>/mpi-tool-block.json` 或当前 session 内存 | 弹出 overlay 勾选要隐藏的 tool，从 active 集合拿掉，模型看不见。 |
| `mpi-permission` | `/permission`，`<agentDir>/mpi-permission.json`，`<cwd>/.pi/mpi-permission.json` | 用 allow / ask / deny 通配符规则把关工具调用，并扫描常见 Bash 文件命令的静态路径；含外部目录与重复调用（doom loop）防护；ask 审批支持 once / always / reject（doom_loop 的 ask 仅 once / reject）。详见 [pi-packages/mpi-permission/README.zh.md](../pi-packages/mpi-permission/README.zh.md)。 |
| `mpi-bash-default-timeout` | 执行 Bash 工具时自动生效 | 为 Bash 工具命令注入默认超时机制，防止任务无限期阻塞。 |
| `mpi-tool-display` | 工具行/Thinking 渲染时自动生效 | 通过 render-only `ToolExecutionComponent` adapter 提供紧凑 `bash`/`read`/`edit`/`write` 行与 bars/分栏 diff，并添加不会污染模型上下文的带主题色 `Thinking:` 标签；原生工具、ownership、execute 与 `PI_*` bash 会话环境完全不动。 |
| `mpi-image-hoist` | 多模态输入时自动生效 | 提取并提升图片载荷，适配多模态模型与工具协议。 |
| `mpi-herdr-report` | `HERDR_ENV=1` 环境生效 | 将 Agent 的运行状态（working / idle / waiting）同步上报至 Herdr 终端复用器窗格。 |
| `mpi-ctl` | `$mpi-ctl`，`mpi status` / `mpi ctl` | Skill：用 `MIXCODE_*` 定位 tab，再用 `mpi status` / `mpi ctl` 控制正在跑的 TUI。 |

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

# Slash 命令与指令清单 (Commands Reference)

[English Documentation](commands.md)

MixCode 在 `src/core/commands.ts` 中注册了内置本地 Slash 命令。这些命令驱动编辑器补全引擎与命令面板（`Ctrl+P`）。

## 持久化层级

命令根据影响范围分为三个持久化层级：

1. **全局 (`[global]`)**：写入 Pi 全局 `<agentDir>/settings.json`，重启依然有效且跨工作目录共享。
2. **工作区 (Workdir)**：写入当前工作目录的 `mixcode_state.json`。
3. **会话 (Session)**：仅在当前运行时内存中生效，重启或重载后重置。

## 命令清单

| 命令 | 参数提示 | 层级 | 说明 |
|---|---|---|---|
| `/models` | `[provider/modelId]` | Session | 打开交互式模型选择器或直接切换当前 Tab 模型。 |
| `/thinking` | `[off\|minimal\|low\|medium\|high\|xhigh\|max]` | Session | 调整模型思考 / 推理深度（Reasoning Effort）。 |
| `/context-limit` | `<tokens\|reset>` | Session | 人为设置上下文窗口上限（用于测试或压缩调优）。 |
| `/workdir` | `[path]` | Workdir | 切换当前 Agent 工作目录并更新文件监听。 |
| `/new-session` | `[--focus\|--no-focus] [title]` | Workdir | 新建 Agent Tab，可指定自定义标题。默认 focus 到新 Tab；`--no-focus` 留在当前 Tab。已占用的标题变为 `title-N`。见 [Tab 标题](workspace-and-tabs.zh.md#tab-标题)。 |
| `/fork` | - | Workdir | 将当前会话分支复制到新 Tab，新 Tab 拥有独立的运行时服务。标题为 `{source}-fork`，已被占用则为 `{source}-fork-N`。见 [Tab 标题](workspace-and-tabs.zh.md#tab-标题)。 |
| `/follow-up` | `<text>` | Session | 向 Follow-up 队列添加消息，在当前轮次完成后优先执行。 |
| `/compact` | `[custom instructions]` | Session | 手动触发当前分支的上下文压缩（Compaction）。 |
| `/reset` | - | Session | 将会话重置回根节点，保留 Session 文件与 Tab 标题。先前分支仍在 `/tree`。 |
| `/clear` | - | Session | 在当前 Tab 生成全新 Session 文件，重置 Tab 标题。 |
| `/close-session` | `[yes]` | Session | 关闭当前 Tab 并释放其内存运行时。加 `yes` 跳过确认框。 |
| `/close-all-sessions`| - | Session | 用户确认后关闭所有打开的 Agent Tab。 |
| `/delete-session` | `[yes]` | Session | 关闭当前 Tab 并永久删除其 `.jsonl` 会话文件。加 `yes` 跳过确认框。 |
| `/delete-all-sessions` | - | Session | 永久删除当前工作目录关联的所有 `.jsonl` 会话文件。 |
| `/tree` | - | Session | 打开交互式会话分支树状查看器。 |
| `/resume` | `[session-id \| N:<tab-name>]` | Session | 打开交互式会话选择器；`/resume <session-id>`（精确 id 或前缀，当前目录优先，其次全部根目录）直接恢复会话。`/resume N:<tab-name>` 先完整精确匹配已打开的 Tab 标题，再匹配完整精确的会话名（当前目录优先）；重名时报告全部候选 id。 |
| `/palette` | - | - | 打开命令面板。与 `Ctrl+P` 相同。 |
| `/jump` | - | - | 打开 Tab 跳转浮层。与 `Ctrl+T` 相同。 |
| `/editor` | - | - | 在 `$VISUAL` / `$EDITOR` 中编辑当前输入草稿。与 `Ctrl+G` 相同。 |
| `/vim` | - | Session | 进入基于 Buffer 滚动的 Vim 对话浏览模式（`q` 退出）。 |
| `/toggle-zen-mode` | - | Session | 开启 / 关闭顶部 Tab 栏的 Zen 专注模式。 |
| `/toggle-inline-widgets` | - | Session | 切换扩展组件是在 Chat 消息流内联渲染还是固定在编辑器上方。 |
| `/toggle-hidden-messages` | - | Session | 显示 / 隐藏扩展内部自定义生成的隐藏消息。 |
| `/hide-thinking` | - | `[global]` | 切换完整思考与配置的预览。默认预览和 `Thinking...` 占位符选项见[设置说明](mixcode-settings.zh.md)。 |
| `/settings` | - | Global | 打开全局主题、图标与 UI 偏好设置面板。 |
| `/login` | `[provider]` | Global | 配置 provider 鉴权。无参数时先选择订阅登录或 API Key；传入精确的 provider id 或名称时直接进入该 provider。凭证通过 `<agentDir>/auth.json` 与 Pi 共享。 |
| `/logout` | - | Global | 移除 `/login` 保存的凭证；环境变量与 `models.json` 鉴权配置保持不变。 |
| `/save-workspace` | `[name]` | Workdir | 将多 Tab 布局写入 `<stateDir>/workspaces.json`。 |
| `/restore-workspace` | `[name]` | Workdir | 恢复已保存工作区；省略名称则打开选择器。 |
| `/delete-workspace` | `[name]` | Workdir | 删除已保存的工作区记录。 |
| `/export` | `[path]` | Session | 省略 `path` 时把 HTML 写到当前 tab 的 workdir；`path` 以 `.jsonl` 结尾则导出 JSONL。相对路径相对 tab workdir 解析。 |
| `/import` | `<jsonl-path>` | Session | 导入外部会话 JSONL 文件至当前工作区。相对路径相对 tab workdir 解析。 |
| `/extension-manager` | - | Workdir | 交互式启用 / 禁用已发现的 Pi 扩展。 |
| `/reload` | - | Session | 重新加载模型配置、项目 Skill 并重新绑定扩展资源。 |
| `/system-prompt` | - | Session | 在外部编辑器中检视或编辑当前组装的 System Prompt；末尾附带各分段大小与估算 token 占比的统计表。 |
| `/system-tools` | - | Session | 检视当前激活的工具 Schema 与所有者信息；末尾附带每个工具的大小与估算 token 占比统计表，只计入真正发给模型的部分（name + description + parameter schema）。 |
| `/console-history` | - | - | 打开当前 `mpi` 进程最近 1000 条经桥接的 `console.log/info/debug/warn/error` 记录。依次检查项目设置、全局设置、`$VISUAL` 和 `$EDITOR`。选中的命令必须通过 1 秒 `--version` 探测。若均未设置，MixCode 依次尝试 `nvim`、`vim`。没有可用的外部编辑器时，MixCode 打开内置只读查看器。重启 `mpi` 会清空历史。 |
| `/hotkeys` | - | - | 查看完整的全局与局部快捷键清单。 |
| `/quit` / `/exit` | - | - | 安全保存当前状态并退出 MixCode。 |

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
| `/new-session` | `[title]` | Workdir | 新建 Agent Tab，可指定自定义标题。 |
| `/fork` | `[suffix]` | Workdir | 将当前会话分支复制到新 Tab，复用底层运行时服务。 |
| `/follow-up` | `<text>` | Session | 向 Follow-up 队列添加消息，在当前轮次完成后优先执行。 |
| `/compact` | `[custom instructions]` | Session | 手动触发当前分支的上下文压缩（Compaction）。 |
| `/reset` | - | Session | 将会话重置回根节点，保留 Session 文件与 Tab 标题。 |
| `/clear` | - | Session | 在当前 Tab 生成全新 Session 文件，重置 Tab 标题。 |
| `/close-session` | - | Session | 关闭当前 Tab 并释放其内存运行时。 |
| `/close-all-sessions`| - | Session | 用户确认后关闭所有打开的 Agent Tab。 |
| `/delete-session` | - | Session | 关闭当前 Tab 并永久删除其 `.jsonl` 会话文件。 |
| `/delete-all-sessions` | - | Session | 永久删除当前工作目录关联的所有 `.jsonl` 会话文件。 |
| `/tree` | - | Session | 打开交互式会话分支树状查看器。 |
| `/navigate` | - | Session | 打开过滤为用户提问的对话快速定位器。 |
| `/vim` | - | Session | 进入基于 Buffer 滚动的 Vim 对话浏览与全文检索模式。 |
| `/toggle-zen-mode` | - | Session | 开启 / 关闭顶部 Tab 栏的 Zen 专注模式。 |
| `/toggle-inline-widgets` | - | Session | 切换挂件是在 Chat 消息流内联渲染还是固定在编辑器上方。 |
| `/toggle-hidden-messages` | - | Session | 显示 / 隐藏扩展内部自定义生成的隐藏消息。 |
| `/hide-thinking` | - | `[global]` | 切换是否将 Thinking 推理内容折叠为占位符。 |
| `/settings` | - | Global | 打开全局主题、图标与 UI 偏好设置面板。 |
| `/save-workspace` | `[name]` | Workdir | 将多 Tab 布局写入 `<stateDir>/workspaces.json`。 |
| `/restore-workspace` | `[name]` | Workdir | 恢复已保存工作区；省略名称则打开选择器。 |
| `/delete-workspace` | `[name]` | Workdir | 删除已保存的工作区记录。 |
| `/export` | `[path]` | Session | 导出为 HTML；路径以 `.jsonl` 结尾时导出 JSONL。 |
| `/import` | `<jsonl-path>` | Session | 导入外部会话 JSONL 文件至当前工作区。 |
| `/extension-manager` | - | Workdir | 交互式启用 / 禁用已发现的 Pi 扩展。 |
| `/reload` | - | Session | 重新加载模型配置、项目 Skill 并重新绑定扩展资源。 |
| `/system-prompt` | - | Session | 在外部编辑器中检视或编辑当前组装的 System Prompt。 |
| `/system-tools` | - | Session | 检视当前激活的工具 Schema 与所有者信息。 |
| `/hotkeys` | - | - | 查看完整的全局与局部快捷键清单。 |
| `/quit` / `/exit` | - | - | 安全保存当前状态并退出 MixCode。 |

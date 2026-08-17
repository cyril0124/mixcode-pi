# 快捷键体系、热键与 Escape 分发机制 (Keybindings & Escape)

[English Documentation](keybindings-and-escape.md)

MixCode Pi 提供完整的全局与局部快捷键映射系统（`src/core/keymap.ts`）以及上下文感知的两阶段 Escape 分发机制（`src/core/escape.ts`）。

## 全局与常用快捷键

| 快捷键 | 作用域 | 动作 | 说明 |
|---|---|---|---|
| `Tab` | 全局 | 下一个 Tab | 切换至下一个 Tab。补全弹窗打开时不切换；Zen 模式下被吞掉（用 `Ctrl+T`）。 |
| `Shift+Tab` | 全局 | 上一个 Tab | 切换至上一个 Tab。补全 / Zen 例外与 `Tab` 相同。 |
| `Ctrl+P` | 全局 | 命令面板 | 打开支持模糊搜索的全局命令面板。 |
| `Ctrl+T` | 全局 | Tab 跳转 | 打开全屏 Tab 快速跳转浮层。 |
| `Ctrl+E` | 全局 | 外部编辑器 | 在 `$VISUAL` / `$EDITOR` 中编辑当前草稿。 |
| `Ctrl+Q` | 全局 | 退出 | 安全保存工作区状态并退出程序。 |
| `Ctrl+C` | 全局 | 清空输入 | 清空编辑器。不会中断正在跑的轮次（中断用 `Esc`）。 |
| `Ctrl+U` | 输入框/队列 | 出队 / Vim | 弹出排队中的消息回输入框；队列为空时预备进入 Vim 模式。 |
| `Right` | 空输入框 | 侧边栏挂件 | 展开 / 折叠右侧扩展挂件面板。 |
| `$` | 编辑器 | Skill 补全 | 触发项目、全局与已安装 package Skill 自动补全。 |
| `@` | 编辑器 | 文件补全 | 触发工作区文件路径自动补全。 |
| `!` | 编辑器 | Bash 命令 | 进入单行 Shell 命令快速执行模式。 |

## Escape 优先级分发流 (`src/core/escape.ts`)

按 `Escape` 键时遵循确定性的优先级逻辑：

```text
用户按下 Escape
        │
        ├─ 1. 浮层处于打开状态？ ──> 关闭当前浮层（Tab 跳转 / 选择器）
        ├─ 2. 补全弹窗处于激活？ ──> 关闭候选补全列表
        ├─ 3. 处于 Vim 模式？ ────> 退出 Vim 模式，焦点返回输入框
        ├─ 4. Steer 队列非空？ ──> 立即刷新转向消息（若正在生成则先中断）
        ├─ 5. Agent 正在运行？
        │      ├─ 第 1 次按下 ────> 预备中断窗口 (PENDING_ESCAPE_CONFIRM_WINDOW_MS = 1000ms)
        │      └─ 第 2 次按下 ────> 中断轮次；若未产生可见输出则将 Prompt 撤回 (Retract) 回编辑器
        └─ 6. 输入框为空且空闲？ ──> 500ms 内连按两次 Esc 打开会话树（或 fork）
```

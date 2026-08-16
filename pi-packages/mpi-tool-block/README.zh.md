# mpi-tool-block

把勾选的 tool 从 active 集合拿掉，模型在 schema / system prompt 里看不见。定义仍注册。

[English](README.md)

## 命令

`/tool-block` — `[global]` 弹出 settings 风格的 overlay，列出全部已注册 tool。

```text
┌─ Tool Block ───────────────────────────────────┐
│  filter: type to filter                        │
│  ~/.pi/agent/tool-block.json                   │
│   mpi-goal ──────────────────────────────────  │
│  › Enabled                         On          │
│    bash                            Visible     │
│    create_goal                     Hidden      │
│  ↑↓ select  ⏎ toggle  type to filter  esc      │
└────────────────────────────────────────────────┘
```

| 按键 | 作用 |
|------|------|
| 输入 | 按 tool 名或插件短名过滤 |
| Space / Enter | 切换 Hidden / Visible，或开关 Enabled |
| Esc | 清空搜索，或关闭 |

每次切换立刻写入 `<agentDir>/tool-block.json` 并调用 `setActiveTools`。小屏开窗显示，标题和底栏保留。

`enabled: Off` 保留 `hidden` 列表，但把这些 tool 放回 active 集合。

## 配置

`<agentDir>/tool-block.json`（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）。第一次勾选时创建，重启后仍生效。

```json
{
  "enabled": true,
  "hidden": [
    { "tool": "browser_navigate", "plugin": "pi-web-access" }
  ]
}
```

| 字段 | 类型 | 契约 |
|------|------|------|
| `enabled` | boolean | 默认 `true`。`false` = 不隐藏。 |
| `hidden[].tool` | string | 精确 tool 名（全局唯一）。 |
| `hidden[].plugin` | string? | 可选扩展标签（`npm:` 包名或 `extensions/<name>`）。核心 / Pi 工具可省略。 |

缺文件 = 零操作。非法 JSON 或未知字段 fail loud：`/tool-block` 报错且不打开 overlay，不覆盖文件。

`session_start` / `/reload` 时重读配置。`before_agent_start` 再读文件并应用。

## 限制

- 没有 `unregisterTool`。被藏的 tool 仍注册，只是模型收不到。
- 工具名全局一份。藏 `foo` 就是这个名字，不是「某个插件的那份」。
- 取消隐藏或关闭 `enabled` 时，只恢复本包装过的名字。

# mpi-tool-block

把勾选的 tool 从 active 集合拿掉，模型在 schema / system prompt 里看不见。定义仍注册。

[English](README.md)

## 命令

`/tool-block` — 弹出 settings 风格的 overlay，列出全部已注册 tool。Layer 决定改动写到哪里。值列是 Visible、Hidden 或 Inactive。

```text
┌─ Tool Block ───────────────────────────────────┐
│  filter: type to filter                        │
│  session (in-memory)                           │
│  › Layer                           Session     │
│    Enabled                         On          │
│    bash                            Visible     │
│    grep                            Inactive    │
│    create_goal                     Hidden      │
│  ↑↓ select  ⏎ toggle  Hidden/Visible/Inactive  │
└────────────────────────────────────────────────┘
```

| 按键 | 作用 |
|------|------|
| 输入 | 按 tool 名、插件短名，或 `hidden` / `visible` / `inactive` 过滤 |
| Space / Enter | 切换 Layer、Enabled，或 Hidden / Visible / Inactive |
| Esc | 清空搜索，或关闭 |

| Layer | 持久化 | 路径行 |
|-------|--------|--------|
| Global | 立刻写入 `<agentDir>/tool-block.json` | 文件路径；若 session 覆盖仍在，前缀 `session override ·` |
| Session | 当前 MixCode tab 内存 | `session (in-memory)` |

第一次切到 Session 会拍一份当前全局配置。只要 session 配置存在，它就是整份生效配置（`session ?? global`）：多藏、解藏、`enabled: Off` 都只作用于这个 tab。切回 Global 只换编辑目标，不丢弃 session。session 在进程重启、`/reload`、关 tab、或 extension 重建后消失。

| 状态 | 含义 |
|------|------|
| Visible | 在当前 active 集合且不在 `hidden[]`。Enabled 打开时与 `/system-tools` 列出的名字相同。 |
| Hidden | 在 `hidden[]` 里。Enabled 打开时从 active 集合拿掉。 |
| Inactive | 已注册、不在 active、也不在 `hidden[]`（Pi 默认的 `grep`/`find`/`ls`、尚未披露的扩展工具）。 |

对 Inactive 按 Space 会写入 `hidden[]`（预藏），但不会激活该工具。再解藏回到 Inactive。每次切换立刻调用 `setActiveTools`。小屏开窗显示，标题和底栏保留。

`enabled: Off` 保留 `hidden` 列表，但把这些 tool 放回 active 集合。overlay 仍标 Hidden。

## 配置

全局文件：`<agentDir>/tool-block.json`（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）。第一次在 Global 层勾选时创建，重启后仍生效。

Session 配置形状相同，只存在于内存，不写盘。

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

缺文件 = 零操作（全局不藏任何 tool）。非法 JSON 或未知字段 fail loud：`/tool-block` 报错且不打开 overlay，不覆盖文件。

`session_start` 和 `before_agent_start` 会重读全局文件并应用生效配置，不会清掉已有的内存 session 覆盖。MixCode `/reload` 会重建 extension 实例，从而丢掉 session 覆盖。

## 限制

- 没有 `unregisterTool`。被藏的 tool 仍注册，只是模型收不到。
- 工具名全局一份。藏 `foo` 就是这个名字，不是「某个插件的那份」。
- 取消隐藏或关闭 `enabled` 时，只恢复本包装过的名字。
- Session 覆盖按 extension 实例隔离（一个 MixCode tab）。overlay 里没有 Clear；用重启、`/reload` 或关 tab 丢掉。

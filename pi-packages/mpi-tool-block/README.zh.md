# mpi-tool-block

把勾选的 tool 从 active 集合拿掉，模型在 schema / system prompt 里看不见。定义仍注册。

[English](README.md)

## Skill

`$mpi-tool-block` 或 `/skill:mpi-tool-block` 载入配置手册。它不进 system prompt（`disable-model-invocation`）。正常安装时 Pi 读取 `pi.skills`；MixCode 把内置包装在 `<agentDir>/extensions/` 下，由 `index.ts` 通过 `resources_discover` 贡献同一份 `skills/` 目录。`$` 补全扫描该目录。包内 skill 不会拷进 `<agentDir>/skills`。

手册：[skills/mpi-tool-block/SKILL.md](skills/mpi-tool-block/SKILL.md)。

## 命令

`/tool-block` 弹出 settings 风格的 overlay，列出全部已注册 tool。Layer 决定改动写到哪里。值列是 Visible、Hidden 或 Inactive。

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
| Global | 立刻写入 `<agentDir>/mpi-tool-block.json` | 文件路径；若 session 覆盖仍在，前缀 `session override ·` |
| Project | 立刻写入 `<cwd>/<CONFIG_DIR_NAME>/mpi-tool-block.json`（如 `.pi`），仅限受信任的项目 | 项目文件路径 |
| Session | 当前 MixCode tab 内存 | `session (in-memory)` |

Layer 行按 Global → Project → Session 循环；项目不受信任时跳过 Project。

Global 与 Project 合并。隐藏集合是两份文件的并集，项目文件只需写自己那几条，不必重写全局那一份。某层 `enabled: Off` 只丢该层的隐藏，列表保留。

session 配置存在时整体取代这个合并结果。多藏、解藏、`enabled: Off` 都只作用于这个 tab。进入 Session 时以合并结果为快照，切回 Global 只换编辑目标。这份覆盖在进程重启、`/reload`、关 tab、或 extension 重建后消失。

列表只显示当前层自己的文件。在别的层被藏的名字在这里显示 Inactive：它不在 active 集合里，也不在本层的 `hidden` 里。

| 状态 | 含义 |
|------|------|
| Visible | 在当前 active 集合且不在 `hidden[]`。Enabled 打开时与 `/system-tools` 列出的名字相同。 |
| Hidden | 在 `hidden[]` 里。Enabled 打开时从 active 集合拿掉。 |
| Inactive | 已注册、不在 active、也不在 `hidden[]`（Pi 默认的 `grep`/`find`/`ls`、尚未披露的扩展工具）。 |

对 Inactive 按 Space 会写入 `hidden[]`（预藏），但不会激活该工具。再解藏回到 Inactive。每次切换立刻调用 `setActiveTools`。小屏开窗显示，标题和底栏保留。

`enabled: Off` 保留 `hidden` 列表，但把这些 tool 放回 active 集合。overlay 仍标 Hidden。

## 配置

全局文件：`<agentDir>/mpi-tool-block.json`（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）。第一次在 Global 层勾选时创建，重启后仍生效。

项目文件：`<cwd>/<CONFIG_DIR_NAME>/mpi-tool-block.json`（例如 `.pi/mpi-tool-block.json`），仅在 Pi 信任该项目时读取。不受信任的仓库不贡献任何内容，包括它的解析错误。第一次在 Project 层勾选时创建。

包内随带 `mpi-tool-block.schema.json`（安装于 `<agentDir>/extensions/mpi-tool-block/`），可在配置中用 `$schema` 键引用以获得编辑器补全；该键被接受并在写回时保留。路径相对于所在文件解析，所以项目文件需要绝对路径或编辑器 schema 映射。

Session 配置形状相同，只存在于内存，不写盘。

```json
{
  "enabled": true,
  "hidden": ["browser_navigate"]
}
```

| 字段 | 类型 | 契约 |
|------|------|------|
| `enabled` | boolean | 默认 `true`。`false` = 不隐藏。 |
| `hidden[]` | string | 精确 tool 名。名字全局唯一，所以同一名字最多出现一次。 |

缺文件 = 该层零操作。非法 JSON、未知字段或非字符串条目 fail loud：`/tool-block` 报出文件名且不打开 overlay，不覆盖文件。全局文件坏掉则什么都不藏；项目文件坏掉则该项目层不贡献内容，全局层照常生效。

`session_start` 和 `before_agent_start` 会重读两份文件并应用生效配置，不会清掉已有的内存 session 覆盖。MixCode `/reload` 会重建 extension 实例，从而丢掉 session 覆盖。

## 限制

- 没有 `unregisterTool`。被藏的 tool 仍注册，只是模型收不到。
- 隐藏以 tool 名为单位，没有按插件分组的作用域。
- 项目文件无法解藏全局文件藏掉的 tool；要从藏着它的那层删掉名字。
- 插件标签由实时注册表算出并显示在 overlay 里；配置只存 tool 名。
- 取消隐藏或关闭 `enabled` 时，只恢复本扩展取下的名字。
- Session 覆盖按 extension 实例隔离（一个 MixCode tab）。overlay 里没有 Clear；用重启、`/reload` 或关 tab 丢掉。

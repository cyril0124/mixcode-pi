# 多标签与工作区管理 (Workspace & Tabs)

[English Documentation](workspace-and-tabs.md)

MixCode Pi 原生提供多 Tab 并发 Agent 会话管理、跨实例状态同步以及工作区（Workspace）持久化能力，彻底打破传统终端 Agent 的单会话限制。

## 设计意图与动机

- **多任务并行与探索**：传统单会话 Agent 在执行长耗时的编译、跑测试或重构时，用户无法同时开展其他探索或代码审查任务。MixCode 允许在单个终端实例内同时运行多个独立的 Agent Tab，各 Tab 拥有独立的会话文件与扩展运行时，彼此完全隔离。
- **访问衰减层级渲染 (`recentTabIds`)**：动态追踪最近访问的前 3 个 Tab（`recent1`、`recent2`、`inactive`），通过分层背景色与高亮标记保持几十个 Tab 并存时的上下文清晰度。
- **状态连续性**：工作区持久化多 Tab 布局、焦点 Tab、工作目录及模型配置，重启终端后一键无损恢复。

## Tab 生命周期

```text
创建 Tab (/new-session / Ctrl+T)
  │
  ├─ 独立的 Session 文件 (`~/.pi/agent/sessions/...`)
  ├─ 独立的 Agent 实例与扩展运行时
  └─ 状态实时登记于 `open_tabs.json`
```

### Tab 操作与实时状态指示

Tab 实时展示运行状态指示符：`●`（运行中/工作中）、`-`（空闲/就绪）、`!`（已完成未读）与 `x`（执行报错）。

| 操作 | 快捷键 / 命令 | 行为 |
|---|---|---|
| 新建 Tab | `/new-session [title]` | 创建全新的 Agent Tab，可指定自定义标题。 |
| 关闭 Tab | `/close-session` | 关闭当前 Tab 并释放其内存中的运行时。 |
| 重置会话 | `/reset` | 在当前 Tab 中将分支指针重置回根节点（保留标题与会话文件）。 |
| 清空会话 | `/clear` | 在当前 Tab 内生成全新的 Session 文件（重置标题）。 |
| 分支复制 | `/fork [suffix]` | 将当前对话历史克隆到新 Tab 中，复用已有底层服务。 |
| Tab 跳转 | `Ctrl+T` | 打开全屏 Tab 检索面板，支持模糊搜索与快速切换。 |
| Tab 轮转 | `Tab` / `Shift+Tab` | 补全关闭时轮转 Tab。Zen 模式下被吞掉（用 `Ctrl+T`）。 |
| Zen 模式 | `/toggle-zen-mode` | 隐藏顶部 Tab 栏，获得专注的 Agent 会话视图。 |

## 工作区持久化 (Workspace)

工作区记录了多 Tab 布局、焦点 Tab、工作目录及模型配置，便于一键保存与跨会话恢复。

### 工作区命令

| 命令 | 说明 |
|---|---|
| `/save-workspace [name]` | 将当前 Tab 布局写入 `<agentDir>/mixcode-pi/workdirs/<sha16>/workspaces.json`。 |
| `/restore-workspace [name]` | 恢复指定工作区；省略名称则打开选择器。 |
| `/delete-workspace [name]` | 从 `workspaces.json` 删除该工作区记录。 |

## 多实例 Tab 状态同步

MixCode 通过对 `open_tabs.json` 的原子文件锁协调多个终端实例或 tmux 窗格间的 Tab 集合变更：

```text
实例 A（创建/关闭 Tab）
    │
    ▼
open_tabs.json（文件锁与状态登记）
    │
    ▼
实例 B（Peer-tab-sync 监听器对账并同步 Tab 集合）
```

# mpi-diff-viewer

[English Documentation](README.md)

MixCode 内置的终端原生交互式 Diff 检视与代码评审扩展，通过 `/diff` 命令唤起。

## 核心特性

- **会话级统一变更回溯**：在当前会话分支中自动聚合工具调用（`edit`、`write`、Unified Patch Hunks）产生的多文件修改。
- **Git 引用对比**：对比已跟踪的工作区与暂存区文本内容变更和 Git 引用（`HEAD`、分支或提交）。
- **TUI 交互式代码评审**：支持直接在 Diff 行上附加行级评审意见（`fix` 修复 / `discuss` 讨论），并一键组合为结构化的 Agent 任务 Prompt。

## 命令一览

| 命令 | 作用 |
|---|---|
| `/diff` | 打开 Diff 查看器，检视当前会话中所做的全部文件变更。 |
| `/diff last` | 只看上一轮用户回合（等同 `/diff 1`）。 |
| `/diff N` / `/diff N-M` | 倒数第 N 轮，或倒数第 N 到倒数第 M 轮之间的会话变更。 |
| `/diff HEAD` | 检视相对 `HEAD` 的未提交已跟踪文本内容修改。 |
| `/diff <ref>` | 检视工作区与暂存区相对某分支或提交的已跟踪文本内容修改。 |

名称为 `last`、纯数字或 `N-M` 的 ref 必须使用完整名称（例如 `refs/heads/last`）；这些短格式保留用于选择会话回合。
无效的 Git ref 会以 `Error: ...` 通知显示。

## 快捷键

| 快捷键 | 行为 |
|---|---|
| `Tab` / `Shift+Tab` | 在文件列表窗格与 Diff 详情窗格间切换焦点。 |
| `j` / `k` 或 `Down` / `Up` | 在文件树中移动；Navigator 隐藏时（`e`）滚动 Diff 内容。 |
| `n` / `p` | 快速跳转至下一个 / 上一个变更块 (Hunk)。 |
| `w` | 折行或截断长行。 |
| `c` | 在当前行添加或编辑行级评审注释（选择 `fix` 或 `discuss`）。 |
| `Enter` | 折叠或展开当前选中的 Navigator 文件夹。 |
| `Escape` / `q` | 关闭 Diff Viewer 浮层。 |

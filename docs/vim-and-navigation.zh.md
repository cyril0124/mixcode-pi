# Vim 模式与对话导航 (Vim Mode & Navigation)

[English Documentation](vim-and-navigation.md)

MixCode 内置针对终端 Agent 对话流优化的 Vim 模式，支持逐行滚动与用户提问快速跳转。

## 设计意图与动机

终端原生 Coding Agent 应当让开发者在查阅历史对话与早期 Prompt 时彻底摆脱鼠标：
- **纯键盘沉浸浏览**：通过主键盘区键位（`j/k`, `Ctrl+U/D`, `g/G`）直接把整个对话流视作只读 Vim Buffer 进行翻页与滚动。
- **用户提问跨度跳跃 (`Right` / `Shift+Right`)**：跳过冗长的工具调用输出，直接在关键的用户提问节点间正向或反向穿梭。

## 进入与退出 Vim 模式

- **进入**：
  - 运行命令 `/vim`。
  - 队列为空时按 `Ctrl+U` 预备进入，并在 1 秒内按 `u`（或再次按 `Ctrl+U`）确认。
- **退出**：按 `q`。
- 空闲且输入框为空时连按两次 `Esc` 打开会话树或 fork。Vim 模式下无效。

## 快捷键一览

| 快捷键 | 模式 | 作用 |
|---|---|---|
| `j` / `k` 或 `Down` / `Up` | Vim | 逐行向下 / 向上滚动对话视口。 |
| `Ctrl+U` / `Ctrl+D` 或 `PageUp` / `PageDown` | Vim | 向上 / 向下翻页。 |
| `g` / `G` | Vim | 快速跳转至对话最顶部（最早消息）/ 最底部（最新消息）。 |
| `Home` / `End` | Vim | 跳转至对话最顶部 / 最底部。 |
| `Right` | Vim | 正向跳转至下一条用户提问；超出末尾时跳转至 `[NEWEST]`。 |
| `Shift+Right` | Vim | 反向跳转至上一条用户提问。 |
| `q` | Vim | 退出 Vim 模式。 |

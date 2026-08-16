# Vim 模式与对话搜索 (Vim Mode & Search)

[English Documentation](vim-and-navigation.md)

MixCode 内置针对终端 Agent 对话流优化的 Vim 模式，支持逐行滚动、用户提问快速跳转以及全文正则/文本检索。

## 设计意图与动机

终端原生 Coding Agent 应当让开发者在查阅历史对话与早期 Prompt 时彻底摆脱鼠标：
- **纯键盘沉浸浏览**：通过主键盘区键位（`j/k`, `Ctrl+F/B`, `g/G`）直接把整个对话流视作只读 Vim Buffer 进行翻页与滚动。
- **用户提问跨度跳跃 (`Right` / `Shift+Right`)**：跳过冗长的工具调用输出，直接在关键的用户提问节点间正向或反向穿梭。
- **WeakMap 语料缓存**：将渲染后的文本语料与视口索引缓存在 WeakMap 中，确保在包含海量历史消息的大型会话中进行 `/` 正则搜索依然零延迟、不卡顿。

## 进入与退出 Vim 模式

- **进入**：
  - 运行命令 `/vim`。
  - 队列为空时按 `Ctrl+U` 预备进入，并在 1 秒内按 `u`（或再次按 `Ctrl+U`）确认。
- **退出**：按 `i`、`a` 或 `Escape` 返回常规 Prompt 输入。
- 空闲且输入框为空时连按两次 `Esc` 打开会话树（或 fork），不会进入 Vim。

## 快捷键一览

| 快捷键 | 模式 | 作用 |
|---|---|---|
| `j` / `k` 或 `Down` / `Up` | Vim | 逐行向下 / 向上滚动对话视口。 |
| `Ctrl+F` / `Ctrl+B` | Vim | 向下 / 向上翻页。 |
| `g` / `G` | Vim | 快速跳转至对话最顶部（最早消息）/ 最底部（最新消息）。 |
| `Right` | Vim | 正向跳转至下一条用户提问；超出末尾时跳转至 `[NEWEST]`。 |
| `Shift+Right` | Vim | 反向跳转至上一条用户提问。 |
| `/` | Vim | 打开 Vim 对话内容搜索栏。 |
| `n` | Vim | 跳转至下一个搜索匹配项。 |
| `N` | Vim | 跳转至上一个搜索匹配项。 |
| `i` / `a` / `Escape` | Vim | 退出 Vim 模式并聚焦回编辑器。 |

## 搜索架构与渲染

```text
Vim 模式 (/)
    │
    ▼
VimTranscriptSearchState
    │
    ├─ 渲染语料缓存于 WeakMap 中（避免重复渲染）
    ├─ 子串 / 正则匹配扫描
    └─ 在 Chat 视口中高亮当前选中的匹配行
```

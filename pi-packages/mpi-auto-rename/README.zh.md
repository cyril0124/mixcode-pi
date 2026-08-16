# mpi-auto-rename

[English Documentation](README.md)

MixCode 内置的轻量化后台 Tab 标题自动生成扩展。

## 功能概述

在新建 Agent 会话的首轮交互完成后，`mpi-auto-rename` 在后台异步调用轻量级模型生成简明、规范的短横线命名标题（例如 `fix-auth-token`），并自动同步至 `open_tabs.json`。

## 命令与配置

```bash
/auto-rename [name]          # 手动触发或指定 Tab 标题
/auto-rename-config          # 交互式选择用于重命名的专用模型
```

配置持久化保存于 `~/.pi/agent/auto-rename.json`：

```jsonc
{
  "model": "anthropic/claude-3-5-haiku" // 或 "inherit"
}
```

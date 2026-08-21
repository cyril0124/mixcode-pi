# `mixcode_settings.json`

[English Documentation](mixcode-settings.md)

MixCode Pi 从其根状态目录读取 `mixcode_settings.json`。默认路径为：

```text
~/.pi/agent/mixcode-pi/mixcode_settings.json
```

该文件采用 JSONC 语法：支持标准 JSON 以及注释和尾随逗号。如果文件不存在，MixCode Pi 使用以下默认设置。

## 支持的配置项

```jsonc
{
  "theme": "tokyo-night",
  "ui": {
    "icons": { "mode": "nerd" },
    "inlineWidgets": false,
    "oversizedAssistantMessage": {
      "enabled": true,
      "maxLines": 5000,
      "maxBytes": 131072,
    },
  },
  // 与 models.json 相互独立：在不删除目录条目的情况下禁用 provider/model。
  "disabledProviders": ["openai"],
  "disabledModels": ["anthropic/claude-opus-4-5"],
}
```

| 配置项 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `theme` | 主题 ID 字符串 | 未设置 → 运行时默认 | 显式 UI 主题 ID。内置主题（`mixcode-dark`、`claude-warm`、`tokyo-night`、`terminal`、`catppuccin`、`kanagawa`、`rose-pine`）、Pi 主题（`dark`/`light`）以及 Pi 发现的任何主题（`~/.pi/agent/themes`、packages）。ID 需精确匹配，MixCode 无额外别名。可通过 `/settings` 编辑。 |
| `ui.icons.mode` | `auto` \| `nerd` \| `ascii` | `nerd` | 输入框 meta 图标、上下文占用指示器、Zen 状态圆点及扩展管理器状态的字符集。`auto` 会在已知的 Nerd Font 终端上选用 Nerd 图标，否则使用 ASCII。在 `/settings` 中作为 “Icon mode” 可编辑。 |
| `ui.inlineWidgets` | 布尔值 | `false` | 新 Tab 及进程启动时的默认行为：将 `setWidget` 渲染在 chat 尾部的 chrome 上方/下方。在 `/settings` 中修改时会立即同步应用到所有已打开的 Tab。每个 Tab 的 `/toggle-inline-widgets` 仍仅限当前会话且不写入 `mixcode_state.json`。在 `/settings` 中作为 “Inline widgets” 可编辑。 |
| `ui.oversizedAssistantMessage.enabled` | 布尔值 | `true` | 在 TUI 中折叠超长的 assistant/thinking 输出，同时在 session 中完整保留；使用 `/view` 查看完整内容。 |
| `ui.oversizedAssistantMessage.maxLines` | 正整数 | `5000` | 超过此行数时折叠 assistant/thinking 输出。 |
| `ui.oversizedAssistantMessage.maxBytes` | 正整数 | `131072` | 超过此 UTF-8 字节大小时折叠 assistant/thinking 输出。 |
| `disabledProviders` | provider id 字符串数组 | `[]` | 在 MixCode 会话以及扩展/子代理模型发现和执行中全局禁用对应 provider。模型仍会在 `/models` 中列出但呈置灰禁用状态且无法选择或使用。在 `/reload` 或重启后生效。可通过 `/settings` 编辑。 |
| `disabledModels` | `provider/modelId` 字符串数组 | `[]` | 在相同路径下全局禁用单个模型。Provider 级别的禁用涵盖该 provider 下的所有模型。在 `/reload` 或重启后生效。可通过 `/settings` 编辑。 |

图片显示与 Mermaid 模式**不**保存在此文件中。它们使用 Pi 全局 `settings.json`（与 `hideThinkingBlock` 相同存储），可通过 `/settings` 编辑：

| Pi 配置项 | 可选值 | 默认值 | 效果 |
| --- | --- | --- | --- |
| `terminal.showImages` | 布尔值 | `true` | 在用户消息和工具结果中显示图片块。 |
| `terminal.imageWidthCells` | 正整数 | `60` | 终端字符单元格中的最大图片宽度。 |
| `images.blockImages` | 布尔值 | `false` | 在图片到达模型前予以剔除（SDK `convertToLlm`）。 |
| `markdown.mermaid` | `off` \| `final` \| `streaming` | `streaming` | 何时将 ` ```mermaid ` 代码块转为终端图表。 |

## 解析规则

- 文件缺失：使用默认配置。
- 允许 JSONC 注释与尾随逗号。
- 历史遗留的 `ui.renderMermaid` 被忽略（改用 Pi `markdown.mermaid`）。
- `ui.icons.mode`：必须为 `auto`、`nerd`、`ascii` 之一；非法值作为设置错误报告。
- `ui.inlineWidgets`：必须为布尔值；非法值作为设置错误报告。
- `ui.oversizedAssistantMessage.enabled`：必须为布尔值。
- `ui.oversizedAssistantMessage.maxLines` 和 `.maxBytes`：必须为正整数。
- 非法的 `ui.oversizedAssistantMessage` 值作为设置错误报告。
- 未知字段被忽略。
- 非法 JSONC 作为设置错误报告。
- `disabledProviders` / `disabledModels`：非数组值视为空；仅保留去空格后的非空字符串。
- 禁用列表不会修改 `models.json`。`/login` 仍会列出已禁用的 provider 以供配置凭证。
- 扩展与子代理不会从 `ctx.modelRegistry.getAvailable()` 中获取已禁用的模型，运行时执行会拒绝已解析但被禁用的模型。完整目录仍可通过 `getAll()`/`find()` 获取以供配置和重新启用。
- 当前模型被禁用的 Tab 保留该模型引用（不自动切换）；提交 prompt 或选择该模型将被拒绝，直到选择启用的模型或重新启用并执行 `/reload`。

Prompt 历史不在此处配置。它属于 `mpi-prompt-history` 包，配置文件为 `<agentDir>/mpi-prompt-history.json`；详见[该包 README](../pi-packages/mpi-prompt-history/README.zh.md)。

## 示例

使用 ASCII 图标并开启内联组件：

```jsonc
{
  // 无 Nerd Font 的终端渲染 ASCII 图标集。
  "ui": {
    "icons": { "mode": "ascii" },
    "inlineWidgets": true,
  },
}
```

诸如 `retry.maxRetries` 和 `retry.baseDelayMs` 等重试配置，以及图片/mermaid 渲染（`terminal.showImages`、`terminal.imageWidthCells`、`images.blockImages`、`markdown.mermaid`）不由 `mixcode_settings.json` 读取；它们来自 Pi 正常的 SettingsManager 配置，可通过 `/settings`（Pi 全局 `settings.json`）进行编辑。

通过 `/settings` 编辑配置会将 `mixcode_settings.json` 重新写回为纯 JSON（注释不会保留）。

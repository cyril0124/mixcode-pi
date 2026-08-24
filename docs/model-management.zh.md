# 模型管理、路由与动态规则 (Model Management)

[English Documentation](model-management.md)

MixCode Pi 提供模型发现、选择、思考深度调整、全局模型禁用以及基于模型的动态能力挂载机制。

## 核心配置文件

```text
~/.pi/agent/models.json            模型定义与自定义 API 端点
~/.pi/agent/auth.json              API 密钥与凭证
~/.pi/agent/mixcode-pi/mixcode_settings.json   disabledProviders 与 disabledModels
~/.pi/agent/mpi-model-skills.json      基于模型的动态 Skill 挂载规则 (mpi-model-skills)
~/.pi/agent/mpi-model-extensions.json  基于模型的动态 Extension 挂载规则 (mpi-model-extensions)
```

## 模型选择与思考深度

- **选择模型**：运行 `/models [provider/modelId]` 或按 `Ctrl+P` → **Choose Model**。
- **调整思考深度**：运行 `/thinking [tier]`。可用档位由模型决定——模型的 `thinkingLevelMap` 可以屏蔽 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 中的任意档。`/thinking <未知值>` 会回报该模型的合法取值。

## 在命令行列出模型

```bash
mpi --list-models [search] [--json]
```

每个已配置鉴权的模型一行，并给出该模型接受的思考档位：

```text
provider  model              context  thinking
faux      faux-1             200K     off,minimal,low,medium,high
deepseek  deepseek-v4-flash  1M       off,low,high,max
deepseek  deepseek-v4-pro    1M       off,high,max                 (disabled)
```

`search` 按 `provider/modelId` 做大小写不敏感过滤。`--json` 输出数组，字段为
`{ id, provider, modelId, displayName, contextWindow, reasoning, disabled, thinking }`。

口径与 `/models` 一致：

- 只列出鉴权可解析的 provider（`auth.json`、`models.json` 的 `apiKey` 或环境变量）；其余与选择器中一样不出现。
- faux 默认模型排在首位；命中 `disabledProviders` / `disabledModels` 的条目保留并标记 `(disabled)`。
- **不含**扩展在运行时通过 `pi.registerProvider` 注册的 provider：该命令只读 `models.json` 与内置目录，不加载扩展。
- 不启动 TUI、不联网、无需运行中的实例，可直接在脚本或另一个 agent tab 中调用。

## 全局模型与 Provider 禁用

禁用规则的权威说明见 [`mixcode_settings.json`](mixcode-settings.zh.md)（`disabledProviders` / `disabledModels`）。此处不重复展开 schema。

## 基于模型的动态规则

### 1. 动态 Skill 挂载 (`mpi-model-skills`)

配置文件 `~/.pi/agent/mpi-model-skills.json`：

```jsonc
{
  "rules": [
    {
      "match": { "model": "anthropic/*" },
      "add": ["tdd", "generic-writing"],
      "remove": ["caveman"]
    }
  ]
}
```

### 2. 动态 Extension 加载 (`mpi-model-extensions`)

配置文件 `~/.pi/agent/mpi-model-extensions.json`：

```jsonc
{
  "rules": [
    {
      "match": { "provider": "deepseek" },
      "add": ["npm:pi-web-access"]
    }
  ]
}
```

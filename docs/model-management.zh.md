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
- **调整思考深度**：运行 `/thinking [tier]`（支持 `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`）。

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

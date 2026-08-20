# mpi-model-skills

按模型**增删技能**：通过重建系统提示词中的 `<available_skills>` 段实现。

[English](README.md)

## 配置

`~/.pi/agent/model-skills.json`（或 `$PI_CODING_AGENT_DIR`）：

包内随带 `model-skills.schema.json`（安装于 `<agentDir>/extensions/mpi-model-skills/`），可在配置中用 `$schema` 键引用以获得编辑器补全；该键被接受并在写回时保留。

```json
{
  "rules": [
    {
      "match": { "missingInput": ["image"] },
      "add": ["vision-proxy"],
      "remove": []
    },
    {
      "match": { "model": "deepseek/*" },
      "add": ["$HOME/.agents/skills/vision-proxy"],
      "remove": ["some-skill"]
    }
  ]
}
```

### `match`

| 字段 | 含义 |
|------|------|
| `model` | 对 `provider/modelId` 的 glob（`*`，如 `deepseek/*`） |
| `missingInput` | 列出的每个模态都必须**不在** `model.input` 中 |
| `hasInput` | 列出的每个模态都必须**存在** |

空 `match: {}` 匹配所有模型。多条命中规则按**数组顺序**依次生效。

### `add`（字符串列表）

| 形式 | 含义 |
|------|------|
| `skill-name` | 从当前已加载技能中解析 |
| `/abs/path`、`~/…`、`$VAR/…`、`${VAR}/…` | 从绝对路径加载技能（目录或 `SKILL.md`） |

相对路径**被拒绝**。同名技能：**add 覆盖**。

### `remove`

仅接受技能**名称**。名称不存在 → 警告通知（幂等）。

## 命令

- `/model-skills` — `[global]` 显示配置路径、命中的规则、生效技能名（markdown 面板，紫色背景）
- `/model-skills help` — 完整配置 schema（markdown）
- `/model-skills on` / `/model-skills off` — 启停规则应用（写入配置的 `enabled`）
- 斜杠补全：参数提示 `[help|on|off]`
- 配置在 session 启动 / `/reload` 时重载（不是每条 prompt）

## 示例：视觉 polyfill

1. 把视觉技能装到已知路径（或作为名为 `vision-proxy` 的常规可发现技能）。
2. 配置：

```json
{
  "rules": [
    {
      "match": { "missingInput": ["image"] },
      "add": ["$HOME/.agents/skills/vision-proxy"]
    }
  ]
}
```

3. `/reload`，然后使用纯文本模型——系统提示词技能列表应包含该视觉技能。

## 已知限制（暂缓）

`mpi-skill-refs`（`$SkillName`）仍按 Pi 原始加载的技能列表解析，而不是本扩展重写后的系统提示词。若 `$` 引用必须保持同步，作为后续跟进项。

# mpi-model-attach

按当前模型增删技能：重写系统提示词里的 `<available_skills>` 段。按当前模型加载额外 Pi 扩展：用宿主 `ExtensionAPI` 调用扩展工厂。

[English](README.md)

## 配置

文件：`~/.pi/agent/mpi-model-attach.json`（或 `$PI_CODING_AGENT_DIR`）。

包内 `mpi-model-attach.schema.json` 安装在 `<agentDir>/extensions/mpi-model-attach/`。在配置里用 `$schema` 指向它，编辑器可以补全。加载器接受该键，写回时保留。

```json
{
  "skills": {
    "rules": [
      {
        "match": { "missingInput": ["image"] },
        "add": ["$HOME/.agents/skills/vision-proxy"]
      }
    ]
  },
  "extensions": {
    "rules": [
      {
        "match": { "model": "deepseek/*" },
        "add": ["$HOME/.pi/agent/model-exts/vision-helper"]
      }
    ]
  }
}
```

不需要的一半直接省略 `skills` 或 `extensions`。

### `match`

| 字段 | 含义 |
|------|------|
| `model` | 对 `provider/modelId` 的 glob（`*`，如 `deepseek/*`） |
| `missingInput` | 列出的每个模态都不在 `model.input` 中 |
| `hasInput` | 列出的每个模态都在 `model.input` 中 |

空 `match: {}` 匹配所有模型。多条命中规则按数组顺序依次生效。

### `skills.add`

| 形式 | 含义 |
|------|------|
| `skill-name` | 从当前已加载技能里取 |
| `/abs/path`、`~/…`、`$VAR/…`、`${VAR}/…` | 从绝对路径加载技能（目录或 `SKILL.md`） |

相对路径会被拒绝。同名技能后写的 add 覆盖先写的。

### `skills.remove`

只接受技能名。名称不存在时警告，其余当作没发生。

### `extensions.add`

| 形式 | 含义 |
|------|------|
| `/abs`、`~/…`、`$VAR/…` | 加载扩展入口（文件，或含 `index.ts` / `index.js` 的目录） |
| `name` | 解析为 `<agentDir>/extensions/<name>` |

相对路径会被拒绝。同一路径每个 session 只加载一次。

### `extensions.remove`

只接受友好名称（包目录名或入口 basename）。只从本包的加载计划里拿掉，不会卸载 Pi 已经加载的扩展。

## 命令

- `/model-attach`（`[global]`）状态：配置路径、命中规则、生效技能、计划中和已加载的扩展
- `/model-attach help` 用 markdown 给出配置 schema
- `/model-attach skills on` / `off` 写入 `skills.enabled`
- `/model-attach extensions on` / `off` 写入 `extensions.enabled`
- 斜杠补全提示：`[help|skills on|off|extensions on|off]`
- 配置在 session 启动和 `/reload` 时重载，不是每条 prompt
- 扩展加载发生在 `session_start`（当前模型），以及 `model_select`（只加新命中的路径）

## 放置

只想对部分模型生效的扩展，不要放进 Pi 总会扫描的目录。用绝对路径指向旁路目录。若 Pi 已经加载过同一路径，本包第一次命中计划时仍会再调工厂，工具可能注册两次。

## 限制

- 本包只调用工厂，不过滤 Pi 的发现列表。
- 切到不再匹配的模型不会卸载任何东西。用 `/reload` 或开新 session。
- `model_select` 只新增新命中的路径，不补放子工厂错过的 `session_start` 钩子。
- `mpi-skill-refs`（`$SkillName`）仍按 Pi 原始加载的技能列表解析，不是重写后的系统提示词。

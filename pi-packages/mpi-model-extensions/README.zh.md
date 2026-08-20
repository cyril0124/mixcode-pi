# mpi-model-extensions

按模型**加载扩展**：用宿主 `ExtensionAPI` 动态调用扩展工厂。

独立 Pi 包——不耦合 MixCode `src/` 运行时。

[English](README.md)

## 配置

`~/.pi/agent/mpi-model-extensions.json`（或 `$PI_CODING_AGENT_DIR`）：

包内随带 `mpi-model-extensions.schema.json`（安装于 `<agentDir>/extensions/mpi-model-extensions/`），可在配置中用 `$schema` 键引用以获得编辑器补全；该键被接受并在写回时保留。

```json
{
  "rules": [
    {
      "match": { "model": "deepseek/*" },
      "add": ["$HOME/.pi/agent/model-exts/vision-helper"]
    },
    {
      "match": { "missingInput": ["image"] },
      "add": ["vision-helper"],
      "remove": []
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
| `/abs`、`~/…`、`$VAR/…` | 加载扩展入口（文件或含 `index.ts`/`index.js` 的目录） |
| `name` | 解析为 `<agentDir>/extensions/<name>` |

相对路径**被拒绝**。相同路径每个 session 只加载**一次**。

### `remove`

仅接受友好**名称**（包目录名 / 入口 basename）。只从本包的加载计划中移除；**不会**卸载 Pi 已加载的扩展。

## 命令

- `/model-extensions` — `[global]` 状态面板
- `/model-extensions help` — schema
- `/model-extensions on` / `off` — 持久化 `enabled`

配置在 session 启动 / `/reload` 时重载。加载发生在 `session_start`（当前模型）与 `model_select`（**仅新增**）。

## 放置建议

只想通过本包加载的模型专属扩展，请放在**不会**被常规发现的目录之外。若 Pi 已加载相同路径，本包首次命中计划时仍会调用工厂（工具可能重复注册）——优先使用绝对路径引用的旁路目录。

## 限制

- 只调用工厂；不过滤 Pi 的发现列表。
- 切换到不匹配的模型**不会**卸载；用 `/reload` 或新 session。
- `model_select` 只新增新命中的路径（不补放子工厂错过的 `session_start` 钩子）。

# Batch Lua

用 Lua 脚本在启动后批量开 agent tab、发 prompt。适合 monorepo 并行任务、模型对比、复用已有 tab 续聊。

## 运行

```bash
# 启动 TUI 后执行脚本
mpi --batch examples/batch/simple.lua

# 把参数传给脚本（`--` 之后全部归脚本）
mpi --batch script.lua -- packages/core packages/cli

# 只校验并打印计划：不启 TUI、不 bootstrap runtime、不写 state/session
mpi --batch script.lua --batch-dry-run -- packages/core
```

执行模型：

```text
Lua 脚本跑完
   │  收集 open_tab
   v
validate (model / thinking / mode)
   │
   ├─ --batch-dry-run → 打印 plan → 退出
   │
   v
apply
  phase1: 按 tab 串行 create / clear / delete
  phase2: 不同 tab 并行发 prompt
          同名 tab 内请求严格串行
```

**不是编排引擎**：脚本不能 `wait` agent 结果，也不能根据回复再分支。一次 collect、一次 apply。

## API（`mixcode` 全局表）

| API | 作用 |
|-----|------|
| `mixcode.open_tab(opts)` | 建 tab 或按 **精确标题** 复用，可选发 prompt |
| `mixcode.args()` | CLI `--` 后的参数，1-indexed 数组 |
| `mixcode.current_workdir()` | 当前 workdir |
| `mixcode.tab_exists(name)` | 启动快照：是否已有同名 tab |
| `mixcode.list_tabs()` | 启动快照：已有 tab 列表 |
| `mixcode.list_models()` | 启动快照：可用模型列表（`id`/`provider`/`model_id`/`display_name`/`context_window`/`reasoning`） |
| `mixcode.render(tpl, vars)` / `render(...)` | `{name}` 模板；`{{` / `}}` 转义字面量 |

标准 Lua 库可用（含 `os.getenv`、`io` 等）。类型桩见仓库根目录 [`mixcode.lua`](../mixcode.lua)。

### `open_tab` 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | tab 标题；复用时精确匹配 |
| `prompt` | 否 | 省略则只建/复用/清/删 tab，不 submit |
| `workdir` | 否 | 该 tab 工作目录 |
| `model` | 否 | 如 `anthropic/claude-sonnet-4-20250514` |
| `thinking` | 否 | 依模型能力：`off` / `minimal` / `low` / … / `max` |
| `system_prompt` | 否 | 仅替换 base/identity（同 SYSTEM.md 槽位）；tools/AGENTS.md/skills 仍由 MixCode 组装。**需要新会话**：新建 tab，或 `mode="clear"` / `mode="delete"`。`append` 复用已有会话会报错 |
| `mode` | 否 | 已存在 tab 时：`append`（默认）/ `clear` / `delete` |

`mode`：

- `append`：在已有会话上继续
- `clear`：清空会话后再发
- `delete`：删 tab + session 文件后新建

prompt 支持普通文本、skills、prompt templates、extension commands、`!shell`。
**不支持** MixCode 本地 slash command（需要交互 UI）。

设置了 `system_prompt` 的 tab，编辑器标题旁显示 `[sys]` 角标。

### 示例

```lua
local pkgs = mixcode.args()
if #pkgs == 0 then
  pkgs = { "packages/core", "packages/cli" }
end

for _, pkg in ipairs(pkgs) do
  mixcode.open_tab({
    name = "lint-" .. pkg,
    workdir = pkg,
    thinking = "low",
    prompt = render("Run lint and typecheck in {pkg}. Fix errors only.", { pkg = pkg }),
  })
end

-- 只预开空 tab，不发 prompt
mixcode.open_tab({ name = "scratch" })
```

更多见 [`examples/batch/`](../examples/batch/)。

## dry-run 输出

```text
Batch dry-run: 2 request(s)
1. name=lint-packages/core thinking=low workdir=packages/core
   prompt: Run lint and typecheck in packages/core. Fix errors only.
2. name=scratch
   prompt: (none)
```

仍会做 model / thinking 校验；非法配置会失败退出。

## 边界

| 做 | 不做 |
|----|------|
| 批量派发 tab + prompt | 等 agent 完成 / 读回复 |
| 启动时 introspection | 运行中 live `list_tabs` |
| 不同 tab 并行 + 同 tab 串行 | 并发上限 / DAG / 依赖边 |
| CLI 参数 + 环境变量（`os.getenv`） | 第二套配置格式（JSON/YAML） |

出错时：Lua 语法/运行错误、未知 model、非法 thinking/mode → 抛错；apply 失败写 stderr 并设 `exitCode=1`。

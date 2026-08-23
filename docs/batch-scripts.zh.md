# Batch Scripts

[English Documentation](batch-scripts.md)

用 Lua 或 TypeScript 脚本在启动后批量开 agent tab、发 prompt。适合 monorepo 并行任务、模型对比、复用已有 tab 续聊。

脚本语言由扩展名决定：`.lua` 走 fengari，`.ts` / `.mts` / `.js` / `.mjs` 以 ES module 形式动态导入。两者产出同一份执行计划，共用全部校验、dry-run 与派发链路。

## 设计意图与动机

在大型多子包工程（Monorepo）或横向评测场景下，手动打开十几个 Tab、频繁切换工作目录、逐一调整模型/思考档位并重复粘贴 Prompt，不仅极其繁琐，且不可复现。

批处理脚本定位为**声明式可编程启动派发语言**：
- **脚本化参数控制**：支持通过 CLI 参数透传（`-- <args...>`）与环境变量（`os.getenv`）进行动态参数化。
- **快速失败校验 (Fail-Fast)**：在实际派发执行前，预先完成模型与思考档位的合法性校验。
- **静态计划可预测 (Dry-Run)**：支持在不启动 TUI、不修改任何状态文件的状态下快速预览派发执行计划。

## 运行

```bash
# 启动 TUI 后执行脚本（Lua 或 TypeScript）
mpi --batch examples/batch/simple.lua
mpi --batch examples/batch/simple.ts

# 把参数传给脚本（`--` 之后全部归脚本）
mpi --batch script.ts -- packages/core packages/cli

# 只校验并打印计划：不启 TUI、不 bootstrap runtime、不写 state/session
mpi --batch script.ts --batch-dry-run -- packages/core
```

执行模型：

```text
脚本跑完（.lua 走 fengari | .ts/.js 走动态导入）
   │  收集 open_tab / openTab
   v
validate (model / thinking / mode)
   │
   ├─ --batch-dry-run → 打印 plan → 退出
   │
   v
apply
  phase 1: 按 tab 串行 create / clear / delete
  phase 2: 不同 tab 并行发 prompt
           同名 tab 内请求严格串行
```

**不是编排引擎**：脚本不能 `wait` agent 结果，也不能根据回复再分支。一次 collect、一次 apply。

## Lua API（`mixcode` 全局表）

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

## TypeScript API

TypeScript/JavaScript 脚本默认导出一个函数，参数是同一套 API 对象。函数可以是 `async`，完成后才收集计划。

```ts
/// <reference path="/path/to/mixcode-batch.d.ts" />

const script: MixCodeBatchScript = async (mixcode) => {
  for (const pkg of mixcode.args()) {
    mixcode.openTab({
      name: `lint-${pkg}`,
      workdir: pkg,
      thinking: "low",
      prompt: `Run lint and typecheck in ${pkg}. Fix errors only.`,
    });
  }
};

export default script;
```

类型桩：仓库根目录 [`mixcode-batch.d.ts`](../mixcode-batch.d.ts)（对应 Lua 的 `mixcode.lua`）。它声明的是全局类型，一行 `/// <reference path="..." />` 即可；不引用也能直接跑。

命名一一对应，TypeScript 侧用 camelCase：

| Lua | TypeScript |
|-----|------------|
| `mixcode.open_tab(opts)` | `mixcode.openTab(opts)` |
| `opts.system_prompt` | `opts.systemPrompt` |
| `mixcode.args()`（1-indexed table） | `mixcode.args()`（`string[]`） |
| `mixcode.current_workdir()` | `mixcode.currentWorkdir()` |
| `mixcode.tab_exists(name)` | `mixcode.tabExists(name)` |
| `mixcode.list_tabs()` → `session_id`、`model` | `mixcode.listTabs()` → `sessionId`、`model` |
| `mixcode.list_models()` → `model_id`、`display_name`、`context_window` | `mixcode.listModels()` → `modelId`、`displayName`、`contextWindow` |
| `mixcode.render(tpl, vars)` / 全局 `render` | `mixcode.render(tpl, vars)`（或直接用模板字符串） |

字段语义、`mode`、`systemPrompt` 的新会话规则、prompt 支持范围与校验都与上方 Lua 一致。

脚本写错时抛错：缺少默认导出或默认导出不是函数、`name` 缺失或非非空字符串、任意选项字段非字符串、`openTab` 传入未知字段（如误写 Lua 的 `system_prompt`）。脚本加载与运行失败会包装为 `Batch script error in <path>`。

**无沙箱**：TypeScript 脚本在 MixCode 进程内以完整宿主权限运行（文件系统、网络、`process`）。把批处理脚本当作你亲自执行的本地可信代码。

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
| CLI 参数 + 环境变量（`os.getenv`、`process.env`） | 第二套配置格式（JSON/YAML） |
| Lua（`.lua`）与 TypeScript/JavaScript（`.ts`/`.mts`/`.js`/`.mjs`） | 为 TypeScript 脚本做沙箱 |

出错时：脚本语法/运行错误、未知 model、非法 thinking/mode → 抛错；apply 失败写 stderr 并设 `exitCode=1`。

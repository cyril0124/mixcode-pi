# Batch Scripts

[English Documentation](batch-scripts.md)

用 Lua 或 TypeScript 脚本在启动后批量开 agent tab、发 prompt。适合 monorepo 并行任务、模型对比、复用已有 tab 续聊。

脚本语言由扩展名决定：`.lua` 走 fengari，`.ts` / `.mts` / `.js` / `.mjs` 以 ES module 形式动态导入。两者产出同一份执行计划，共用全部校验、dry-run 与派发链路。

## 设计意图与动机

在大型多子包工程（Monorepo）或横向评测场景下，手动打开十几个 Tab、频繁切换工作目录、逐一调整模型/思考档位并重复粘贴 Prompt，既繁琐又易错，且不可复现。

批处理脚本是一套**声明式可编程启动派发语言**：
- 通过 CLI 参数透传（`-- <args...>`）与环境变量（`os.getenv`）动态参数化运行。
- 派发前先校验模型与思考档位的兼容性。
- Dry-run 预览派发执行计划，不启动 TUI、不写任何状态文件。

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
| `mixcode.resolve_model(query)` | 将精确模型 ID 解析为已启用的 `provider/modelId`，见[模型解析](#模型解析) |
| `mixcode.render(tpl, vars)` / `render(...)` | `{name}` 模板；`{{` / `}}` 转义字面量 |

标准 Lua 库可用（含 `os.getenv`、`io` 等）。根目录 [`mixcode-batch.d.lua`](../mixcode-batch.d.lua) 是指向 `mpi-batch-skill` 随包分发的 [Lua API reference](../pi-packages/mpi-batch-skill/skills/mpi-batch/references/mixcode-batch.d.lua) 的软链接。

### `open_tab` 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | tab 标题；复用时精确匹配 |
| `prompt` | 否 | 省略则只建/复用/清/删 tab，不 submit |
| `workdir` | 否 | 该 tab 工作目录 |
| `model` | 否 | 如 `anthropic/claude-sonnet-4-20250514` |
| `thinking` | 否 | 依模型能力：`off` / `minimal` / `low` / … / `max` |
| `system_prompt` | 否 | 仅替换 base/identity（同 SYSTEM.md 槽位）；tools/AGENTS.md/skills 仍由 MixCode 组装。需要新建 tab 或 `mode="delete"`。与 `mode="clear"` 组合始终报错，即使没有同名 tab；`append` 复用已有会话也会报错 |
| `mode` | 否 | 已存在 tab 时：`append`（默认）/ `clear` / `delete` |

`mode`：

- `append`：在已有会话上继续
- `clear`：与交互式 `/reset` 一样，先将当前分支重置到会话根部，再发送 prompt。保留标题、session ID/文件、工作目录和系统提示词；旧历史仍在 `/tree`，但不进入新对话上下文。不重载扩展或重建服务。agent 正在流式输出或 bash 正在运行时拒绝重置
- `delete`：删 tab + session 文件后新建

没有同名 tab 时新建 tab。`clear` + `system_prompt` 在任何 tab 操作前的校验阶段始终被拒绝，包括系统提示词为空字符串的情况。同名重复请求仅由第一条决定新建/重置/删除行为。交互式 `/clear` 仍会替换会话并重置标题。

prompt 使用[共用输入分发](architecture.zh.md#运行时映射)，支持普通文本、文件路径、
skills、prompt templates、extension commands 和 `!shell` / `!!shell`。
已注册的 MixCode 本地 slash command 会在 prompt 分发阶段被拒绝，须在交互式 TUI 中执行。

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

-- 重置已有同名 tab，不发送 prompt
mixcode.open_tab({ name = "review", mode = "clear" })
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

根目录 [`mixcode-batch.d.ts`](../mixcode-batch.d.ts) 是指向 `mpi-batch-skill` 随包分发的 [TypeScript API reference](../pi-packages/mpi-batch-skill/skills/mpi-batch/references/mixcode-batch.d.ts) 的软链接。它声明的是全局类型，一行 `/// <reference path="..." />` 即可；不引用也能直接跑。

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
| `mixcode.resolve_model(query)` | `mixcode.resolveModel(query)` |
| `mixcode.render(tpl, vars)` / 全局 `render` | `mixcode.render(tpl, vars)`（或直接用模板字符串） |

字段语义、`mode`、`systemPrompt` 的新会话规则、prompt 支持范围与校验都与上方 Lua 一致。

脚本写错时抛错：缺少默认导出或默认导出不是函数、`name` 缺失或非非空字符串、任意选项字段非字符串、`openTab` 传入未知字段（如误写 Lua 的 `system_prompt`）。脚本加载与运行失败会包装为 `Batch script error in <path>`。

**无沙箱**：TypeScript 脚本在 MixCode 进程内以完整宿主权限运行（文件系统、网络、`process`）。把批处理脚本当作你亲自执行的本地可信代码。

## 模型解析

开 Tab 前，将模型 ID 解析为本机的 provider 引用：

```lua
mixcode.open_tab({ name = "review", model = mixcode.resolve_model("claude-sonnet-4-5") })
```

```ts
export default (mixcode: MixCodeBatchApi) => {
  mixcode.openTab({ name: "review", model: mixcode.resolveModel("claude-sonnet-4-5") });
};
```

`resolve_model(query)` / `resolveModel(query)` 接受一个非空字符串，返回规范的 `provider/modelId` 字符串。去除首尾空白后，基于启动模型目录区分大小写地匹配：

1. 精确的完整引用优先，即使同一字符串也是其他模型的裸 ID。显式引用已禁用的模型会失败，不改换 provider。
2. 否则匹配完整模型 ID，包括其中的 `/`，排除禁用候选。
3. 优先选择启动默认模型的 provider；没有对应候选时，按 JavaScript 字符串顺序选择名称最小的 provider，不依赖目录顺序。

解析器读取启动快照。优先 provider 来自 MixCode 的启动模型；当 Pi 的 `defaultProvider` / `defaultModel` 对应模型已配置时，启动模型遵循该设置。恢复的 Tab 不决定此偏好。

解析仅精确匹配，不替换模型版本。它不发送网络请求，也不验证凭证或服务可用性。自动选择不比较价格和数据策略；需要指定 provider 时传入完整的 `provider/modelId`。

| 失败原因 | 错误 |
| --- | --- |
| 空字符串或非字符串查询 | `Error: Model query must be a non-empty string` |
| 没有已启用的匹配项 | `Error: No available model matches: <query>` |
| 显式引用已禁用的模型 | `Error: Model is disabled: <query>` |

脚本错误包含脚本路径。模型解析在收集脚本期间执行，早于 batch 请求的应用。

dry-run 使用相同的选择规则，并在 `model=...` 中显示解析后的完整引用。读取全局和项目设置时不获取写锁；读取或解析错误会中止校验。它不加载运行时扩展，也不获取网络发现的模型，因此目录可能与正式启动不同。校验失败不写状态、会话或崩溃日志；脚本本身仍拥有宿主权限。

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

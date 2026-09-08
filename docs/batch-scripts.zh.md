# Batch scripts

[English Documentation](batch-scripts.md)

用 Lua 或 TypeScript 脚本在启动时或当前 TUI 中批量开 agent tab、发 prompt。适合 monorepo 并行任务、模型对比、复用已有 tab 续聊。

脚本语言由扩展名决定：`.lua` 走 fengari，`.ts` / `.mts` / `.js` / `.mjs` 以 ES module 形式动态导入。两者产出同一份执行计划，共用全部校验、dry-run 与派发链路。

## 运行

### 当前 TUI

在 Agent tab 或 Home 输入：

```text
/batch <script> [-- <args...>]
/batch "scripts/review batch.ts" -- "packages/core" '' 'literal\path'
```

脚本参数必须放在 `--` 后。单双引号用于组合参数，空引号保留为空字符串。反斜杠转义下一个字符，但单引号内不转义。引号未闭合或末尾存在未完成的转义时，在加载前报错。不展开 shell 变量、命令或 glob。

调用目录是发起命令的 Agent tab workdir；Home 使用实例 workdir。相对脚本路径和新 tab workdir 以调用目录为基准，`currentWorkdir()` / `current_workdir()` 返回该目录。`append` 和 `clear` 复用的已有 tab 保留原 workdir。

`/batch` 保持 `process.cwd()` 不变。脚本自行读写相对路径文件时，应显式基于 API workdir 解析路径。

每次调用在执行脚本前，捕获 tab、模型、禁用模型 ID 和实例默认 provider 的固定快照。

预览计划请使用 [CLI dry-run](#启动-cli)。

### 启动 CLI

`--workdir <directory>` 指定启动 workdir，默认使用 shell cwd。相对脚本路径和新 tab workdir 以启动目录为基准。CLI 启动一个新的 TUI 实例。

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

脚本在派发前收集一次计划，无法读取 agent 回复或根据结果分支。

## Lua API（`mixcode` 全局表）

| API | 作用 |
|-----|------|
| `mixcode.open_tab(opts)` | 建 tab 或按 **精确标题** 复用，可选发 prompt |
| `mixcode.args()` | 两种入口中 `--` 后的参数，1-indexed 数组 |
| `mixcode.current_workdir()` | 调用目录，见[运行](#运行) |
| `mixcode.tab_exists(name)` | 调用快照：是否已有同名 tab |
| `mixcode.list_tabs()` | 调用快照：已有 tab 列表 |
| `mixcode.list_models()` | 调用时的模型目录，包含禁用项但不提供 disabled 字段（`id`/`provider`/`model_id`/`display_name`/`context_window`/`reasoning`） |
| `mixcode.resolve_model(query)` | 将精确模型 ID 解析为已启用的 `provider/modelId`，见[模型解析](#模型解析) |
| `mixcode.render(tpl, vars)` / `render(...)` | `{name}` 模板；`{{` / `}}` 转义字面量 |

Lua 每次调用都会重新读取并执行文件，提供 `os.getenv`、`io` 等标准库。根目录 [`mixcode-batch.d.lua`](../mixcode-batch.d.lua) 是指向 `mpi-batch-skill` 随包分发的 [Lua API reference](../pi-packages/mpi-batch-skill/skills/mpi-batch/references/mixcode-batch.d.lua) 的软链接。

### `open_tab` 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | tab 标题；复用时精确匹配 |
| `prompt` | 否 | 省略则只建/复用/清/删 tab，不 submit |
| `workdir` | 否 | 新 tab 工作目录；默认值和相对路径以调用目录为基准。复用/clear 保留已有目录 |
| `model` | 否 | 如 `anthropic/claude-sonnet-4-20250514` |
| `thinking` | 否 | 依模型能力：`off` / `minimal` / `low` / … / `max` |
| `context_limit` | 否 | 正数 token 上限、`/context-limit` 值或 `reset`，仅作用于该 session |
| `system_prompt` | 否 | 仅替换 base/identity（同 SYSTEM.md 槽位）；tools/AGENTS.md/skills 仍由 MixCode 组装。需要新建 tab 或 `mode="delete"`。与 `mode="clear"` 组合始终报错，即使没有同名 tab；`append` 复用已有会话也会报错 |
| `mode` | 否 | 已存在 tab 时：`append`（默认）/ `clear` / `delete` |

`mode`：

- `append`：在已有会话上继续；流式输出期间发送的 prompt 使用 steering
- `clear`：与交互式 `/reset` 一样，先将当前分支重置到会话根部，再发送 prompt。保留标题、session ID/文件、工作目录和系统提示词；旧历史仍在 `/tree`，但不进入新对话上下文。不改变焦点、不重载扩展或重建服务。agent 正在流式输出或 bash 正在运行时拒绝重置
- `delete`：删 tab + session 文件后新建

新 tab，包括 `delete` 重建的 tab，会获取焦点。

没有同名 tab 时新建 tab。`clear` + `system_prompt` 在任何 tab 操作前的校验阶段始终被拒绝，包括系统提示词为空字符串的情况。同名重复请求仅由第一条决定新建/重置/删除行为。交互式 `/clear` 仍会替换会话并重置标题。

prompt 使用[共用输入分发](architecture.zh.md#运行时映射)，支持普通文本、文件路径、
skills、prompt templates、extension commands 和 `!shell` / `!!shell`。
已注册的 MixCode 本地 slash command，包括 `/batch`，会在 prompt 分发阶段被拒绝，须在交互式 TUI 中执行。
其他 slash 输入和路径原样交给 Pi；未匹配的输入，例如 `/unknown`，成为消息文本。

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

TypeScript/JavaScript 脚本默认导出一个接收 API 对象的函数。函数可以是 `async`，完成后才收集计划。每次调用会向函数传入新的上下文。ES module 保持缓存，模块级状态会保留，修改文件后需要重启 MixCode。

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

TypeScript 脚本拥有宿主的文件、网络和进程访问权限。只执行可信脚本；dry-run 也会执行其中的代码。

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

`resolve_model(query)` / `resolveModel(query)` 接受一个非空字符串，返回规范的 `provider/modelId` 字符串。去除首尾空白后，基于调用时的模型目录区分大小写地匹配：

1. 精确的完整引用优先，即使同一字符串也是其他模型的裸 ID。显式引用已禁用的模型会失败，不改换 provider。
2. 否则匹配完整模型 ID，包括其中的 `/`，排除禁用候选。
3. 优先选择本次调用的实例默认模型 provider；没有对应候选时，按 JavaScript 字符串顺序选择名称最小的 provider，不依赖目录顺序。

解析器使用捕获的实例默认模型 provider 和禁用模型 ID。`/batch` 每次调用都会刷新这些值，不由发起调用的 tab 模型决定。启动入口使用 MixCode 的启动模型；当 Pi 的 `defaultProvider` / `defaultModel` 对应模型已配置时遵循该设置，恢复的 tab 不决定此偏好。

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

## 执行与错误

不同 tab 组并行执行，没有可配置的并发上限。同一组内的请求按顺序执行。

对 `/batch`，目标为 `Not Ready` 时，在应用任何请求前报错：`Error: Batch tab is still loading: <name>`。tab 操作、提交结束，以及 apply 完成或失败后，串行保存状态。

串行准备 tab 时失败，batch 会停止，不会开始派发 prompt。并行派发时某组失败，其他组继续运行。两种情况下都保留已应用的变更；失败请求不会自动重试。`/batch` 显示 `Error:` 消息，不改变进程退出码。启动 CLI 的 apply 失败显示在 TUI notice 中，并设 `exitCode=1`；脚本或校验错误也会使 CLI 命令失败。

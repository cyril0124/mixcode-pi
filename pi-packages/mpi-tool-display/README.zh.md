# mpi-tool-display

[English](README.md)

为 `bash`、`read`、`edit`、`write` 与 Thinking 块提供 render-only 转写展示。原生工具定义、ownership、执行逻辑、settings 和会话环境保持不变。可选的全局调试设置可在每个工具调用下追加格式化 JSON 参数。

## 行为

| 界面 | 折叠态 / 空闲态 | 展开态 / 运行态 |
| --- | --- | --- |
| `bash` | 一行：`bash <label>`、命令的 dim 摘录，加右对齐的状态 meta；结果区为空。失败时在行下方保留其尾部输出。详见「bash 折叠行」 | 10 帧 spinner + 运行耗时；实时输出不折叠；展开预览上限 4000 行 |
| `read` | `↳ loaded N lines • Ctrl+O to expand` | 展开预览上限 4000 行 |
| `read` 指向 `SKILL.md` | `[skill] <父目录>`；折叠结果为空 | 文件正文 |
| `edit` | diff 折叠上限为换行前的 24 个内容行，超出部分给出提示 | 运行中显示 pending diff；展开上限为 4000 个终端行 |
| `write` | 基于执行前内容显示覆写 diff；新文件显示为纯新增；diff 上限与 `edit` 相同 | 运行中显示 pending diff；展开上限为 4000 个终端行 |
| Thinking | 带主题色的 `Thinking:` 前缀 | 流式更新持续保留标签 |

调用行格式为 `bash <label>`、`read path[:range]`、`edit path (N lines)` 和 `write path (N lines • size)`，行首的词始终是工具名。展开一行（点击或 `ctrl+o`）后回到 shell 形式：`$ <command>`。

### bash 折叠行

无论 label 多长、终端多窄，折叠行始终恰好一行。舍弃顺序是：先命令摘录，再把 label 压缩到至少 8 列，
然后依次舍弃 `timeout Ns` 与 `shell <path>`、`ctrl+o`，最后舍弃整个 meta。

label 就是调用自己的 `description` 参数（折叠行开启时 `mpi-bash` 要求提供它），没有该参数时退回到截断后的命令：

| label 来源 | 该行 |
| --- | --- |
| 调用自己的 `description` 参数 | `bash Find callers of the parser` |
| 没有该参数的调用退回到截断后的命令 | `bash rg -n parser src \| head -30` |

行内 label 之后还有命令的 dim 单行摘录，连续空白会折叠成一个空格：

```text
bash Find callers of the parser  rg -n parser src | head -30        ok · 40 lines · 0s · ctrl+o
```

摘录只占 label 用不到的列，因此长命令最多把 label 压到摘录 12 列的底线，不会再低；label 被省略之前摘录
先让出列宽，在窄终端上先消失。label 已经带着的命令不再重复显示为摘录，一行里不会出现两遍同样的文字；label 退回命令文本的调用
因此也不显示摘录。

运行中的调用显示 `~ <elapsed>`。已结束的调用显示 `ok`，或 `!! exit N`、`!! timed out`、
`!! aborted`、`!! failed`，后接输出行数（`1 line`、`32 lines`），并在行内有计时时附带耗时。状态取自结果
的最后一行，Pi 把状态追加在那里。失败调用在行下方保留至多 `bashFailureTailLines`（3）行非空输出，取自
输出的末尾；没有状态行的失败（参数校验或启动失败）改取开头三行，因为它的信息在开头。展开后显示
完整命令与完整输出预览。

diff 使用 bars 指示；宽度不小于 120 列时左右分栏，低于 120 列时使用 unified；支持 word wrap 和 Pi 语法高亮。折叠预算中每个内容行只计一次，其换行后的所有终端行均完整保留；分栏中左右配对的一行计一次。表头和 hunk/文件元信息不占预算。余量提示在折叠时统计隐藏的内容行，在展开时统计隐藏的终端行。diff 参数与 bash 失败尾行数（`bashFailureTailLines`）由 `DEFAULT_TOOL_DISPLAY_CONFIG` 定义。原始参数展示另行配置。

## 配置

运行 `/mpi-tool-display config` 打开全局设置 overlay。用 `j`/`k` 或方向键选中某一项，Enter 切换，Esc 关闭。修改会立即持久化到 `<agentDir>/mpi-tool-display.json`；`<agentDir>` 优先使用 `PI_CODING_AGENT_DIR`，否则默认为 `~/.pi/agent`。

```json
{
  "showRawToolArguments": false,
  "compactBashCallRow": true
}
```

`compactBashCallRow` 默认为 `true`，用于选择上文的折叠行。关闭后回到两行展示：调用行显示完整命令，结果行显示 `↳ N lines returned • Ctrl+O to expand`（失败时保留 `↳ command failed` 表头和头部预览）。设置面板负责写文件；切换只影响之后渲染的调用，`/reload` 会重建已有行。该开关同时决定 `mpi-bash` 是否要求提供作为 label 来源的 `description` 参数，读取时机见 `pi-packages/mpi-bash/README.md`。

`compactBashCommandHint` 会被接受并忽略：仍带有该键的配置文件照常加载；摘录本身没有开关。

`showRawToolArguments` 默认为 `false`。启用后，每个工具调用保留其专用、原生或标题 fallback 展示，并追加 `JSON.stringify(args, null, 2)`。工具结果不变。当前标签页的后续调用使用新值；`/reload` 会重建已有行。其他标签页在下一次 agent turn 前重新读取配置。

参数可能包含凭据、prompt、文件内容或大型 payload。错误 JSON、未知字段和非布尔值会被拒绝；上述被忽略的键是唯一例外。

## Thinking 契约

Thinking 块通过 Pi 的 `message_update` 与 `message_end` extension events 添加标签。格式化按 API 判断并保持幂等。

每次模型调用前，`context` handler 会从 assistant Thinking 块中剥离标签和 ANSI 展示序列。展示格式不会进入模型上下文。

## 执行契约

包不调用 `registerTool`，不创建工具定义、不包装 `execute`、不读取 shell settings、不抢工具 ownership。带形状守卫且 reload 可恢复的 adapter 通过 Pi `ToolExecutionComponent` 为 `bash`、`read`、`edit`、`write` 选择 call/result renderer。当 `read` 目标为 `SKILL.md` 时，adapter 交回工具定义的原生 renderer；折叠时渲染 `[skill] <父目录>`。其他有定义工具使用各自的 renderer。call wrapper 在可选地追加原始参数时仍保持每个 renderer 的 `lastComponent` 状态。没有定义的工具继续使用 Pi generic formatter，并保留其原生结果文本。`showRawToolArguments` 为 off 时，该 formatter 收不到参数对象。

原生定义继续负责 cwd、shell path/prefix、permission wrapper 和 bash 子进程环境（`PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`）。公开 `tool_call` 事件只为显示而捕获 write 执行前的文件内容，不 block、不修改工具输入。

## 许可证声明

参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

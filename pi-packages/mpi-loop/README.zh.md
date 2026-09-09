# mpi-loop

[English Documentation](README.md)

MixCode 内置的定时循环 Prompt 执行引擎，支持时间间隔调度、冲突处理策略、编辑器底部状态挂件与全屏交互式管理浮层。

## 命令与使用

```bash
/loop                          # 打开全屏管理浮层
/loop [interval] [--max-runs N] [--] <prompt> # 创建定时任务
/loop max-runs <id|name> <N|unlimited>      # 设置总执行次数
/loop stop <id|name>           # 停止指定定时任务
/loop interval <id> <interval> # 调整已有任务的时间间隔
/loop prompt <id> <prompt>     # 修改已有任务的 Prompt 文本
```

- **时间间隔**：支持秒 `s`、分 `m`、时 `h`、天 `d`（例如 `10s`, `5m`, `1h`）。最小 `10s`，默认 `10m`。
- **下次执行时间**：挂件和浮层显示小时及剩余分钟（`in 1h59m`），或天数及剩余小时（`in 1d23h`）。余数为零时省略；不足一小时显示整分钟或整秒。该显示不改变定时器间隔。
- **总执行次数**：创建时、通过 `/loop max-runs` 或在详情页设置上限，见[执行次数上限](#执行次数上限)。
- **冲突处理模式**：`skip`（繁忙时跳过）或 `defer`（繁忙时合并并在空闲后立即执行）。
- **Prompt 展开**：定时 Prompt 按照手输输入的方式投递 —— 斜杠命令会被派发，`/skill:<name>` 与 Prompt 模板会被展开，与你在编辑器里亲手输入完全一致。

## 执行次数上限

```bash
/loop 2h --max-runs 3 check deploy status
/loop --max-runs 3 check deploy status
/loop max-runs 1 5
/loop max-runs 1 unlimited
```

`--max-runs N` 在创建时设置总次数，放在可选时间间隔之后、Prompt 之前；省略时不限次数。`N` 必须是十进制正安全整数，最大为 `9007199254740991`。缺少参数值、非法次数或 Prompt 之前重复指定参数，均报 `Error:`，不创建任务。

创建时立即执行的第一轮，以及后续定时或延后投递的轮次，均计入总次数。达到上限后移除任务并清理定时器。跳过的定时触发和手动按 `f` 执行不改变计数。上限为 `1` 时只投递创建时的第一轮。

`/loop max-runs <id|name> <N|unlimited>` 修改已有任务的总次数，不是剩余次数。修改保留已执行次数、时间间隔、下次执行时间和等待状态，不触发执行。设置值低于已执行次数时报 `Error:`；等于已执行次数时立即停止任务并丢弃等待中的投递。`unlimited` 取消次数限制；现有自动过期和冲突规则仍然适用。

详情页使用同一套校验：运行 `/loop`，选择任务，按 `Enter` 后按 `c`。输入总次数，留空则取消限制。命令与界面修改同一个上限，并在 `RUNS` 中显示。

参数仅在 Prompt 开始之前解析；`check --max-runs 3` 保持为原始 Prompt 文本。使用 `--` 可让其后全部内容保持原样，包括末尾的 `every` 子句：

```bash
/loop 2h -- --max-runs 3
/loop --max-runs 3 -- check every 2h
```

未使用 `--` 时，省略开头时间间隔的形式支持末尾时间子句，例如 `/loop --max-runs 3 check every 2 hours`。明确指定的开头时间间隔优先。

## 管理浮层快捷键

| 快捷键 | 行为 |
|---|---|
| `Down` / `Up` 或 `Tab` / `Shift+Tab` | 在列表中选择定时任务 |
| `Enter` | 打开选中任务的详情页 |
| `f` | 立即执行选中任务 |
| `x` | 删除选中任务 |
| `c` | 确认后删除全部任务 |
| `Escape` / `q` | 关闭管理浮层 |
| `c`（详情页） | 设置总执行次数；留空表示无限 |
| `m`（详情页） | 切换冲突处理模式（`skip` / `defer`） |
| `f`（详情页） | 立即执行当前任务 |
| `x`（详情页） | 删除当前任务 |
| `Left` / `Escape`（详情页） | 返回任务列表 |

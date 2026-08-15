# 环境变量

[English Documentation](environment.md)

`src/` 拥有或设置的面向用户的 MixCode 产品级环境变量。
此处不列出：`run.sh` / 测试 / GIF 工具参数，或上游 Pi (`PI_*`) 变量——相关内容请参见 Pi 官方文档。

**约定**

- 产品/宿主变量使用 `MIXCODE` / `MIXCODE_*` 前缀。
- 除非特别说明，“设置”指非空字符串。布尔型标志在代码规格化时将 `0`、`false` 和 `off`（不区分大小写）视为关闭。

## 宿主标识

| 变量 | 设置方 | 含义 |
| --- | --- | --- |
| `MIXCODE` | MixCode (`src/cli/main.ts`) 在决定**不**委托给上游 `pi` 之后设置 | 表明当前进程是 MixCode 而非纯 `pi`。必须不能在纯 Pi 下激活的内置包应以此为门控（例如 `mpi-herdr-report`）。MixCode 运行时的默认值：`1`（`??=`，不会覆盖显式设置的值）。未设置 / 为空 / `0` / `false` / `off` 时视为关闭。 |

## Agent Bash 工具（每次派生）

仅注入到 **Agent bash 工具** 子进程环境中（与 Pi `PI_SESSION_*` 范围一致）。未在宿主进程上设置；也不会注入到用户的 `!` / `!!` shell 中。

| 变量 | 设置方 | 含义 |
| --- | --- | --- |
| `MIXCODE_TAB_TITLE` | Bash 工具派生 | 拥有该 Agent 的 Tab 标题（例如 `Agent-01`）。在下次派生时跟随重命名。 |
| `MIXCODE_FOCUSED_TAB_TITLE` | Bash 工具派生 | UI 处于焦点状态的 Agent Tab 标题。当焦点处于 Home/配置或未知时未设置。当后台 Tab 运行 bash 时可能与 `MIXCODE_TAB_TITLE` 不同。 |

## 相关外部宿主

终端复用器可能会注入其自身的环境变量（例如 `HERDR_*`）。这些由对应宿主定义，而非 MixCode。与此类宿主交互的内置包应在包自身内记录所需变量，并继续在 `MIXCODE` 上门控 MixCode 专属行为。

## 添加新变量

1. `src/` 中由 MixCode 拥有且面向用户的参数，优先使用 `MIXCODE_*` 前缀。
2. 在本文档中记录（表格行 + 设置方 + 语义）。
3. 如果影响到内置包或纯 `pi` 协同加载，在 **宿主标识** 下或对应包的 `README` / 头部注释中说明门控条件。
4. 避免无提示的双重名称；选择一个标准变量名。
5. 请勿将仅用于脚本、测试或上游 Pi 的环境变量放入本文档。

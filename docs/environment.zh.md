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
| `MIXCODE_FOCUSED_TAB_TITLE` | Bash 工具派生 | UI 处于焦点状态的 Agent Tab 标题。当焦点处于 Home 或未知时未设置。当后台 Tab 运行 bash 时可能与 `MIXCODE_TAB_TITLE` 不同。 |
| `MIXCODE_PID` | Bash 工具派生 | 拥有该 Agent 的 mpi 宿主进程 PID。`mpi ctl` 将其作为隐式 `--pid`（显式 `--pid`/`--workdir` 仍优先生效）。对脱离进程树的后代（nohup/setsid）比 `$PPID` 更可靠。 |

## 资源发现与隔离

用于将资源扫描（skills、extensions）限制在项目/工作区或内置范围内的环境变量。

| 变量 | 设置方 | 含义 |
| --- | --- | --- |
| `MIXCODE_BUILTIN_EXTENSIONS_ONLY` | 用户 / 环境 | 启用时（`1`、`true`、`on`、`yes`），仅加载 MixCode 内置扩展（`pi-packages/*`），跳过第三方/全局/工作区扩展的自动发现。等同于命令行参数 `--builtin-extensions-only`。未设置 / 为空 / `0` / `false` / `off` / `no` 时视为关闭。 |
| `MIXCODE_PROJECT_SKILLS_ONLY` | 用户 / 环境 | 启用时（`1`、`true`、`on`、`yes`），从 `$` 补全和会话提示词中排除 workdir 外的 Skill，包括全局用户 Skill 和内置 package Skill。未设置 / 为空 / `0` / `false` / `off` / `no` 时视为关闭。 |

### Skill 隔离语义 (`MIXCODE_PROJECT_SKILLS_ONLY`)

默认情况下，MixCode 按照以下层级优先级从四类来源发现并合并 Skill：
1. 项目/工作区：`<workdir>/.agents/skills`（以及 `<workdir>/.pi/skills`）
2. 用户全局：`~/.agents/skills`
3. Agent 全局：`<agentDir>/skills`（默认 `~/.pi/agent/skills`）
4. 已安装 package：npm/git package 的 `skills/` 目录，以及通过 `resources_discover` 提供的内置 `<agentDir>/extensions/<package>/skills` 根目录

当设置 `MIXCODE_PROJECT_SKILLS_ONLY` 为 `1` / `true` / `on` / `yes` 时：
- **`$` 补全**：`scanSkillEntries` 只扫描 `<workdir>/.agents/skills`。
- **会话提示词**：Pi 仍会发现默认 Skill 根目录；MixCode 随后丢弃 `scope === "user"` 的 Skill，以及 `filePath` 不在 workdir 下的 Skill。`<workdir>/.agents/skills` 与 `<workdir>/.pi/skills` 会保留。
- **适用场景**：多仓库隔离、评测，或避免全局个人 Skill 进入项目会话提示词。

### 纯内置扩展隔离 (`MIXCODE_BUILTIN_EXTENSIONS_ONLY`)

启用时：
- MixCode 跳过 `<agentDir>/extensions/` 与 npm node_modules 中第三方/全局扩展的自动扫描发现。
- 仅加载 MixCode 原生第一方内置包（`pi-packages/mpi-*`）。
- 等同于启动时传入 `--builtin-extensions-only` 命令行参数。

## 界面展示覆盖 (UI 渲染)

用于在 TUI 中覆盖元数据展示（例如录屏、演示或敏感路径/模型脱敏）的环境变量，仅影响展示层，不修改底层的实际模型调用、会话数据、思考级别或文件系统路径。

| 变量 | 设置方 | 含义 |
| --- | --- | --- |
| `MIXCODE_DISPLAY_MODEL` | 用户 / 环境 | 覆盖底部元数据栏中显示的 provider/model 字符串（例如 `custom-model`）。 |
| `MIXCODE_DISPLAY_THINKING` | 用户 / 环境 | 覆盖底部元数据栏中显示的 thinking 级别文本（例如 `High`、`DeepThinking`）。 |
| `MIXCODE_DISPLAY_WORKDIR` | 用户 / 环境 | 覆盖底部元数据栏以及 Home 卡片中显示的工作目录路径（例如 `/virtual/demo`）。 |

## 相关外部宿主

终端复用器可能会注入其自身的环境变量（例如 `HERDR_*`）。这些由对应宿主定义，而非 MixCode。与此类宿主交互的内置包应在包自身内记录所需变量，并继续在 `MIXCODE` 上门控 MixCode 专属行为。

## 添加新变量

1. `src/` 中由 MixCode 拥有且面向用户的参数，优先使用 `MIXCODE_*` 前缀。
2. 在本文档中记录（表格行 + 设置方 + 语义）。
3. 如果影响到内置包或纯 `pi` 协同加载，在 **宿主标识** 下或对应包的 `README` / 头部注释中说明门控条件。
4. 避免无提示的双重名称；选择一个标准变量名。
5. 请勿将仅用于脚本、测试或上游 Pi 的环境变量放入本文档。

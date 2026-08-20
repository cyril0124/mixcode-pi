# mpi-permission

用 `allow` / `ask` / `deny` 规则把关工具调用。每次 `tool_call` 都会按分层通配符规则求值；`ask` 弹出审批对话框，`deny` 直接拦截并在原因中给出命中的规则。

规则语义（allow/ask/deny 三动作、按工具的通配符规则对象、last-match-wins、ask 审批）参考 [opencode 的 permission 配置](https://opencode.ai/docs/zh-cn/permissions/)，并适配为 Pi 实际工具名与 MixCode 的配置层级。

[English](README.md)

## 配置

| 层级 | 文件 | 说明 |
|------|------|------|
| 全局 | `<agentDir>/mpi-permission.json`（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`） | 存在即生效。 |
| 项目 | `<cwd>/.pi/mpi-permission.json`（目录名跟随发行版的 `CONFIG_DIR_NAME`） | 仅在项目受信任时生效；未受信任时整体忽略（包括解析错误）。 |
| 会话 | 内存 | ask 对话框的 "Always allow" 授权与 overlay 编辑；重启、`/reload`、关标签页即丢弃。 |

文件缺失即完全不介入：任何一层都没有配置时，该包不改变任何行为。配置文件存在但解析失败则**失败关闭**（fail closed）：所有工具调用都会被拦截，原因中带文件路径与错误，直到修复为止。

根值是动作字符串或对象。键为实际工具名（`bash`、`read`、`edit`、`write`、`grep`、`find`、`ls` 及任意扩展工具名）、`*`（工具自身无命中规则时的兜底），以及防护项 `external_directory` 与 `doom_loop`：

```json
{
  "$schema": "extensions/mpi-permission/mpi-permission.schema.json",
  "*": "allow",
  "bash": { "*": "ask", "git *": "allow", "git push*": "deny" },
  "read": { "*": "allow", "*.env": "deny", "*.env.example": "allow" },
  "edit": { "*": "deny", "src/*": "allow" },
  "external_directory": { "*": "ask", "~/notes/**": "allow" },
  "doom_loop": "ask"
}
```

| 形式 | 含义 |
|------|------|
| `"<tool>": "allow" \| "ask" \| "deny"` | 该工具所有调用采用同一动作。 |
| `"<tool>": { "<模式>": 动作, ... }` | 对该工具 subject 的模式规则；**最后匹配的规则优先**，因此把 `"*"` 放最前、具体规则放后面。 |
| `"doom_loop": 动作` | 仅接受动作字符串，不支持模式。语义见[防护项](#防护项)。 |
| `"$schema": 字符串` | 可选的编辑器 schema 引用；解析接受、overlay 写回时保留，求值忽略。 |

包内随带 `mpi-permission.schema.json`（安装于 `<agentDir>/extensions/mpi-permission/mpi-permission.schema.json`），供编辑器补全与校验。全局文件中直接使用上例的相对路径即可；项目文件请用绝对路径或编辑器的 schema 映射。

## 匹配

- `*` 匹配零个或多个任意字符（含 `/`），`?` 精确匹配一个字符，其余按字面值。
- 模式开头的 `~` 或 `$HOME` 展开为主目录。
- 层级按 全局 → 项目 → 会话 拼接；在整个列表上最后匹配者胜，因此后面的层覆盖前面的层。
- 未命中任何规则默认 `allow`。

各工具的匹配 subject：

| 工具 | 匹配对象 |
|------|----------|
| `bash` | 每个解析后的命令分段（按 `\n`、`;`、`\|`、`&&`、`\|\|` 切分；剥离注释与 heredoc 正文；去引号；空白折叠；丢弃前导环境变量赋值及透明包装器 `sudo` / `env` / `command` / `builtin` / `exec`）。复合命令取最严格分段的决策（`deny` > `ask` > `allow`）。 |
| `read` / `edit` / `write` / `ls` | 绝对文件路径。相对模式同时匹配 cwd 相对形式与绝对形式，所以 `*.env`、`src/*`、`/abs/*` 都可用。 |
| `grep` / `find` | 搜索 `pattern` 输入。 |
| 其他工具 | `JSON.stringify(input)`；字符串形式规则（`"tool": "deny"`）恒适用。 |

## 防护项

### `external_directory`

路径类工具（`read` / `edit` / `write` / `ls`，以及带 `path` 输入的 `grep` / `find`）解析到工作目录之外时，该路径会额外按 `external_directory` 规则求值；最终决策取工具规则与防护规则中更严格者。containment 检查前会 realpath 最深的已存在祖先，因此项目内符号链接不能隐藏外部目标，末尾路径尚不存在时也能判定。该键下无规则即防护关闭（在其中写 `"*": "ask"` 可把关全部外部访问）。不解析 bash 命令中的路径。

### `doom_loop`

用于打断 Agent 重试死循环：同一工具以字节相同的输入（按 `JSON.stringify(input)` 比较）**连续**调用 3 次时，配置的动作作用于第 3 次及之后每一次连续重复调用。

- 计数仅限连续：换工具或换输入即重置为 1。审批通过**不会**重置计数——第 4 次相同调用会再次触发。
- 该防护与工具规则独立求值，按严格度合并（`deny` > `ask` > `allow`），所以 allow 工具规则——包括会话内的 "Always allow" 授权——压不住它。要关闭：删掉该键，或在更后的层写 `"doom_loop": "allow"`（会话覆盖项目、项目覆盖全局）。
- 它的 `ask` 对话框只有 Allow once / Reject；提供 "always" 会让防护形同虚设。
- 计数器为每个 MixCode 标签页内存独立，从防护配置后的第一次调用开始。

以 `"doom_loop": "ask"` 为例：

```text
bash: echo same    #1 执行
bash: echo same    #2 执行
bash: echo same    #3 弹框 "repeated with identical input"
bash: echo same    #4 再次弹框（连续计数未断）
bash: echo other   计数重置；之后的 `echo same` 从 #1 重新计
```

## Ask 对话框

| 选项 | 效果 |
|------|------|
| Allow once | 仅放行本次调用。 |
| Always allow: `键[模式]` | 追加一条会话层 allow 规则并放行。bash 建议前一到两个命令词加 `*`（如 `git status*`）；路径与 pattern 授予精确 subject；外部路径授予 `<父目录>/*`。 |
| Reject / Esc | 拦截调用，原因为 `rejected by user`。 |

无交互界面时（`-p` / JSON 模式、子代理），`ask` 以明确原因拦截——审批必须有 UI。

弹框期间命令**尚未**开始执行：进程在批准后才 spawn，bash 的 `timeout` 也从 spawn 才开始计时，不含审批等待。工具行的耗时显示与最终的 `Took …` 从 `tool_execution_start`（审批之前）起算，因此包含你停留在对话框的时间；等待期间工作行会显示 `waiting for permission approval…`。

## 命令

`/permission` — 覆盖三个层级的 settings 式 overlay。

```text
┌─ Permission ───────────────────────────────────┐
│  /home/user/.pi/agent/mpi-permission.json          │
│  › Layer                           Global      │
│    doom_loop                       Off         │
│      same tool + identical input 3×…          │
│   bash ───────────────────────────────────     │
│    *                               ask         │
│    git *                           allow       │
│  ↑↓ select  ⏎ cycle allow/ask/deny  n new  d   │
└────────────────────────────────────────────────┘
```

| 按键 | 动作 |
|------|------|
| Enter / Space | 循环 Layer（Global → Project → Session）、循环规则动作、或循环 `doom_loop`（Off → ask → deny → allow → Off）。 |
| `n` | 新建规则三步向导：**1/3 键名** — 从候选列表选（`*`、`external_directory` 与已注册工具名；输入即过滤，↑↓ 选择，回车取高亮候选或自由文本）；**2/3 模式** — 预填 `*`，按键名给出示例；**3/3 动作** — Space/←→ 选 allow / ask / deny，回车添加。Esc 逐步回退。 |
| `d` | 删除选中规则（键下无规则时整键消失），或把 `doom_loop` 重置为 Off。 |
| Esc | 取消输入行，或关闭。 |

Global 与 Project 的编辑立即写入对应文件；项目未受信任时 Project 层编辑被拒绝。Session 编辑仅存内存。

## 限制

- 不支持按子代理定制规则集；子代理会话加载同样的配置文件，且因无 UI，`ask` 视为拦截。
- `bash` 匹配的是规整化后的 token 形式（引号已去除），模式匹配 `git commit -m a b` 而非原始引号形式。
- 会话层 "always" 授权不持久化；需长期生效请改写全局或项目规则。

# mpi-prompt-history

MixCode prompt 召回文件的唯一生产者，并提供 `/prompt-history` 浏览器。

## 文件

prompt 召回数据文件和锁文件位于 `<agentDir>/mpi-prompt-history/`（`agentDir` 遵循 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）：

| 文件 | 结构 | 写入时机 |
| --- | --- | --- |
| `history.jsonl` | `{"session_id": string, "ts": number（Unix 秒）, "text": string}` | 每次提交录入，以及回填时 |
| `session_index.jsonl` | `{"id", "title", "updated_at", "path", "cwd"}`，按 `updated_at` 降序 | 索引缺失、扫描到的 session 路径未入索引、存在比索引更新的 session 文件，或更新当前 session 记录 |
| `.locks/prompt-history.lock` | PID 锁记录 | `history.jsonl` 的每次读-改-写期间持有 |

新 prompt 追加到 `history.jsonl`。重写历史文件和更新索引时，使用临时文件和原子重命名。数据文件权限为 `0600`，数据目录权限为 `0700`。`title` 依次取 session 名称、首条用户消息、session id。

## 行为

| 事件 | 动作 |
| --- | --- |
| `input`（`source: "interactive"`） | 将原始提交文本追加到 `history.jsonl`，随后按字节预算裁剪 |
| `session_start` | 每进程每 sessions root 一次：从 session JSONL 回填最近 30 天（按 `session_id`+`ts`+`text` 去重）、重建过期索引，并更新当前 session 记录 |
| `before_agent_start` | 将两个文件的路径写入 `systemPromptOptions.sections["mpi-prompt-history"]` |

启动时覆盖活跃 session 文件所在目录和当前 workdir 的默认 Pi session 目录，每进程对每个不同目录扫描一次。切换 workdir 后，活跃 session 文件可能仍留在原目录。索引由所有 workdir 共享。索引时间较新不代表已经覆盖当前目录：缺少 session 路径也会触发重建。重建在共享锁内按 session id 合并记录，保留最新元数据，不删除其他 workdir 或尚未落盘的活跃会话。

后台扫描和 prompt 写入在 I/O 前保存来源会话的身份信息，可在会话替换或重载后完成。`session_shutdown` 会停用该会话的通知。共享扫描的结果独立于 UI 上下文保存；等待扫描的活跃会话分别报告扫描警告。

重建时逐个处理 session 文件，跨文件只保留用户 prompt 候选和索引元数据。保留的字符串独立复制，避免继续占用整个文件的底层存储。解析累计约 10 毫秒后，在 JSONL 行之间让出事件循环；单行解析仍同步执行。30 天回填截止时间在扫描结束后统一计算。录入和回填均使用线性的 UTF-8 字节计数裁剪历史，在配置预算内保留最新的完整记录行。回填仅序列化裁剪后需要保留的记录。

指针块只含路径，不含历史内容。Pi 将它作为结构化提示词持久化，后续扩展的指令仍可生效，路径未变化时不会重复生成提示词更新。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/prompt-history` | 以 Session 范围打开浏览器。 |
| `/prompt-history config` | 编辑下方配置：选 `maxBytes` 输入新大小，或重置为默认值。 |

按 `/` 使用大小写不敏感的 JavaScript 正则表达式搜索。非法表达式会显示在浏览器中。方向键仍可移动。`j`、`k`、`c`、`q` 会写入查询。`Ctrl+G` 在 Session、Workdir、Global 之间循环切换，并保留查询内容。

| 按键 | 作用 |
| --- | --- |
| `j` / `k` 或 ↑ / ↓ | 下一项 / 上一项 |
| `Ctrl+D` / `Ctrl+U` | 半页下 / 上 |
| `g` / `G` | 首项 / 末项 |
| `/` | 打开搜索 |
| Enter | 插入当前选中的 prompt |
| `c` | 复制当前选中的 prompt 到剪贴板并关闭 |
| `Ctrl+G` | 循环切换 Session / Workdir / Global |
| Esc | 取消搜索，或关闭 |
| `q` | 关闭 |

| 范围 | 数据源 | 说明 |
| --- | --- | --- |
| Session | `ctx.sessionManager` 条目 | 仅当前会话，全程不读 `history.jsonl`。 |
| Workdir | `session_index.jsonl` 关联 `history.jsonl` | 规范化后的 `cwd` 与当前 workdir 完全匹配的会话，不包含子目录或其他 worktree。相同文本只保留本范围内最近一次，最新在前。 |
| Global | `history.jsonl` | 全部已录入的 prompt，相同文本只保留最近一次，最新在前。 |

Workdir 和 Global 在首次切入时加载，读取期间显示加载提示。Workdir 会等待 session 启动时的回填和索引完成后再生成快照；使用同一目录的标签页共同等待尚未完成的扫描。各范围的快照保留到面板关闭；加载失败后，再次切入会重试。切换保留搜索词并选中首条结果，Workdir 标题显示当前目录路径。两个范围只读取数据文件，不打开 session 正文，也不加锁或改写任何文件。session 启动时会更新 session index，因此新会话在下次打开时出现在 Workdir 范围；查询不会推断索引中缺失的记录。路径匹配消除 `.` / `..` 和末尾分隔符，不解析符号链接。原始日志中重复极多，两个范围都只保留同一范围内每个文本的最近一次。

`config` 接受纯字节数或带单位后缀（`20mb`、`512 KB`、`1048576`），非正整数字节一律拒绝。

## 激活门控

录入、回填与注入仅在三个条件同时成立时运行：

- `MIXCODE` 已设置且不为 `0`/`false`/`off`。这会排除同样加载本包的上游 `pi`。
- `MIXCODE_PID` 等于当前进程 PID。这会排除继承宿主环境变量的子进程。
- `ctx.mode === "tui"`。进程内子代理创建时不传 mode，返回 `"print"`。子代理的 `input` 事件也会报告 `source: "interactive"`，所以仅靠 source 过滤无法排除。

`/prompt-history` 不受这些条件限制，始终可用。

子代理的 prompt 不会被录入。子代理可以通过父会话的 system prompt 继承历史文件路径，本包不会向子代理会话注入这些路径。

## 配置

`<agentDir>/mpi-prompt-history.json`，完全由本包拥有。文件可选。

```jsonc
{
  "$schema": "./mpi-prompt-history.schema.json",
  "maxBytes": 15728640
}
```

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `maxBytes` | 正整数 | `15728640`（15 MiB） | `history.jsonl` 的字节预算。超出后从最旧的行开始裁剪。 |
| `$schema` | 字符串 | 无 | 仅供编辑器提示，运行时忽略。 |

文件缺失或未写 `maxBytes` 时使用默认值。非法 JSON、根不是对象、未知键或 `maxBytes` 不是正整数，都会产生包含配置文件路径的错误。

使用 `/prompt-history config` 或直接编辑文件。本包的配置独立于 `mixcode_settings.json` 和 `/settings`。

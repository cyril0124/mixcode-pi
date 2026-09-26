# mpi-prompt-history

MixCode prompt 召回文件的唯一生产者,并提供 `/prompt-history` 浏览器。

## 文件

两个文件都位于包自有数据目录 `<agentDir>/mpi-prompt-history/`(`agentDir` 遵循 `PI_CODING_AGENT_DIR`,默认 `~/.pi/agent`):

| 文件 | 结构 | 写入时机 |
| --- | --- | --- |
| `history.jsonl` | `{"session_id": string, "ts": number(unix 秒), "text": string}` | 每次录入提交,以及回填时 |
| `session_index.jsonl` | `{"id", "title", "updated_at", "path", "cwd"}`,按 `updated_at` 降序 | 索引缺失,或存在比索引更新的 session 文件 |
| `.locks/prompt-history.lock` | PID 锁记录 | `history.jsonl` 的每次读-改-写期间持有 |

文件以原子方式写入(temp + rename),权限 `0600`;数据目录权限 `0700`。`title` 回退链:session 名称 -> 首条用户消息 -> session id。

## 行为

| 事件 | 动作 |
| --- | --- |
| `input`(`source: "interactive"`) | 将原始提交文本追加到 `history.jsonl`,随后按字节预算裁剪 |
| `session_start` | 每进程每 sessions root 一次：从 session JSONL 回填最近 30 天（按 `session_id`+`ts`+`text` 去重）、重建过期索引，并更新当前 session 记录 |
| `before_agent_start` | 将给出两个文件路径的 5 行指针块写入 `systemPromptOptions.sections["mpi-prompt-history"]` |

重建时逐个处理 session 文件，跨文件只保留用户 prompt 候选和索引元数据。保留的字符串独立复制，避免继续占用整个文件的底层存储。解析累计约 10 毫秒后，在 JSONL 行之间让出事件循环；单行解析仍同步执行。30 天回填截止时间在扫描结束后统一计算。录入和回填均使用线性的 UTF-8 字节计数裁剪历史，在配置预算内保留最新的完整记录行。回填仅序列化裁剪后需要保留的记录。

指针块只含路径,绝不含历史内容。Pi 将它作为结构化提示词持久化，后续扩展的指令仍可生效，路径未变化时不会重复生成提示词更新。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/prompt-history` | 以 **Session** 范围打开浏览器。 |
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

Workdir 和 Global 在首次切入时加载，读取期间显示加载提示。各范围的快照保留到面板关闭；加载失败后，再次切入会重试。切换保留搜索词并选中首条结果，Workdir 标题显示当前目录路径。两个范围只读取数据文件，不打开 session 正文，也不加锁或改写任何文件。session 启动时会更新 session index，因此新会话在下次打开时出现在 Workdir 范围；索引中缺少的记录不会在查询时补猜。路径匹配消除 `.` / `..` 和末尾分隔符，不解析符号链接。原始日志中重复极多，两个范围都只保留同一范围内每个文本的最近一次。

`config` 接受纯字节数或带单位后缀（`20mb`、`512 KB`、`1048576`），非正整数字节一律拒绝。

## 激活门控

录入、回填与注入仅在三个条件同时成立时运行:

- `MIXCODE` 已设置且不为 `0`/`false`/`off` —— 排除上游 `pi`(它同样会加载本包);
- `MIXCODE_PID` 等于当前进程 pid —— 排除仅继承了环境变量的子进程;
- `ctx.mode === "tui"` —— 排除进程内子代理会话:子代理创建时不传 mode,因而为 `"print"`。子代理的 `input` 事件 `source` 同样是 `"interactive"`,故仅靠 source 过滤无法排除。

`/prompt-history` 不受门控影响,始终可用。

子代理的 prompt 永不被录入。当子代理框架用父会话的 system prompt 组装子会话提示时,子代理仍可能**看到**指针文本 —— 那是该框架的继承行为,并非本包的注入。

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

文件缺失或未写 `maxBytes` 时使用默认值。其余情况一律 fail loud，不静默回退：非法 JSON、根不是对象、未知键、`maxBytes` 不是正整数，都会抛错且错误信息包含出问题的文件路径。

该配置不属于 `mixcode_settings.json`，也不出现在 `/settings` 中 —— 与 `mpi-tool-block.json` 同一约定，直接编辑文件即可。

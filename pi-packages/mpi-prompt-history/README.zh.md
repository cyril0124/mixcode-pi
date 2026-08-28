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
| `session_start` | 每进程每 sessions root 一次:从 session JSONL 回填最近 30 天(按 `session_id`+`ts`+`text` 去重),索引过期时重建 |
| `before_agent_start` | 向系统提示追加 5 行指针块,给出两个文件路径 |

指针块只含路径,绝不含历史内容。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/prompt-history` | 以 **Session** 范围打开浏览器。 |
| `/prompt-history config` | 编辑下方配置：选 `maxBytes` 输入新大小，或重置为默认值。 |

按 `/` 搜索。方向键仍可移动。`j`、`k`、`c`、`q` 会写入查询。`Ctrl+G` 切换 Session 和 Global，查询还在。

| 按键 | 作用 |
| --- | --- |
| `j` / `k` 或 ↑ / ↓ | 下一项 / 上一项 |
| `Ctrl+D` / `Ctrl+U` | 半页下 / 上 |
| `g` / `G` | 首项 / 末项 |
| `/` | 打开搜索 |
| Enter | 插入当前选中的 prompt |
| `c` | 复制当前选中的 prompt 到剪贴板并关闭 |
| `Ctrl+G` | 切换 Session / Global |
| Esc | 取消搜索，或关闭 |
| `q` | 关闭 |

| 范围 | 数据源 | 说明 |
| --- | --- | --- |
| Session | `ctx.sessionManager` 条目 | 仅当前会话，全程不读 `history.jsonl`。 |
| Global | `history.jsonl` | 全部已录入的 prompt，相同文本只保留最近一次，最新在前。 |

Global 在**首次切入时**才加载（不在打开时），读取期间显示占位提示 —— 该文件可达数 MB，同步解析会阻塞渲染帧。读取不加锁、不写入，因此浏览不会干扰正在进行的录入。去重是必需的：原始日志重复极多（真实文件曾为 20347 行对应 10676 条唯一 prompt）。

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
